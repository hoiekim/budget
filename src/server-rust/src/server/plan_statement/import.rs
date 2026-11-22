//! Stores the rows the plan-statement import page planned:
//! `src/server/lib/plan-statement/import.ts`.
//!
//! The request is the TypeScript's `PlanStatementImportRequest` as JSON, in
//! the shape the route has checked it to have:
//!
//! ```text
//! { account_id,
//!   transactions: [{ transaction, restated_from?, reinvested_distribution? }],
//!   mappings: [{ investment, security_id, restated }],
//!   replace: [security_id],
//!   holdings: [{ security_id, date, quantity, cost_basis, price }] }
//! ```
//!
//! The answer is its `PlanStatementImportResult`: `{ written, alreadyImported }`,
//! or `{ written: 0, alreadyImported: 0, deleted }` when planned rows were
//! deleted from the account.

use indexmap::{IndexMap, IndexSet};
use serde_json::json;

use crate::common::constants::{REINVESTED_DISTRIBUTION, RESTATED_FROM};
use crate::common::date::is_calendar_date;
use crate::common::plan_statement::plan::{KIND_SPECS, PLAN_STATEMENT_ID_PATTERN};
use crate::filters;
use crate::js::{self, Json, Obj};
use crate::server::compute_tools::backfill_snapshots::{backfill_monthly_security_snapshots_forward, BackfillOptions, BackfillSecurityRef};
use crate::server::logger;
use crate::server::postgres::client::{with_transaction, Executor};
use crate::server::postgres::database::{QueryData, SearchFilters};
use crate::server::postgres::models::base::str_of;
use crate::server::postgres::models::{account, investment_transaction, MaskedUser, UpdateArgs};
use crate::server::postgres::repositories::accounts::get_account;
use crate::server::postgres::repositories::holdings::upsert_holding_or_throw;
use crate::server::postgres::repositories::items::get_item;
use crate::server::postgres::repositories::securities::search_securities_by_id;
use crate::server::postgres::repositories::sharing::get_row_owner;
use crate::server::postgres::repositories::snapshots::{
    get_holding_snapshots_for_securities, soft_delete_holding_snapshots, HoldingSnapshotsForSecuritiesOptions,
};

/// Rows per INSERT. Each row binds 14 parameters and Postgres takes at most
/// 65,535 in one statement.
const INSERT_CHUNK_ROWS: usize = 1000;

const MAX_CURRENCY_LENGTH: usize = 10;

/// `SHARE_SUBTYPES.has(subtype ?? "")`: the subtype of some statement kind's share movement.
fn is_share_subtype(subtype: Option<&Json>) -> bool {
    let Some(Json::String(subtype)) = subtype else { return false };
    KIND_SPECS.iter().any(|(_, spec)| spec.subtype == subtype)
}

/// `CASH_SUBTYPES.has(subtype ?? "")`: the subtype of some statement kind's cash leg.
fn is_cash_subtype(subtype: Option<&Json>) -> bool {
    let Some(Json::String(subtype)) = subtype else { return false };
    KIND_SPECS.iter().any(|(_, spec)| spec.cash.is_some_and(|cash| cash.subtype == subtype))
}

fn is_finite_number(value: Option<&Json>) -> bool {
    matches!(value, Some(Json::Number(n)) if n.as_f64().is_some_and(f64::is_finite))
}

/// `isCalendarDate(value)`: a `YYYY-MM-DD` string naming a day on the calendar.
fn is_calendar_date_value(value: Option<&Json>) -> bool {
    matches!(value, Some(Json::String(text)) if is_calendar_date(text))
}

/// `object.key` on a value that may be anything: a primitive, an array or
/// `undefined` has none of the keys read here.
fn prop<'a>(object: Option<&'a Json>, key: &str) -> Option<&'a Json> {
    object.and_then(|object| object.as_object()).and_then(|object| object.get(key))
}

/// A value that is present, `undefined` dropped: what `JSON.stringify` keeps of a property.
fn put(object: &mut Obj, key: &str, value: Option<&Json>) {
    if let Some(value) = value {
        object.insert(key.to_string(), value.clone());
    }
}

/// The `transaction` of a planned row; the route only lets objects through.
fn transaction_of(planned: &Json) -> Option<&Obj> {
    planned.get("transaction").and_then(Json::as_object)
}

/// The string a field holds where it can only be one: the route checked it, or the row's model did.
fn text_of<'a>(object: &'a Json, key: &str) -> &'a str {
    object.get(key).and_then(Json::as_str).unwrap_or_default()
}

/// Which of the ids are already in the account: live, or deleted by someone.
#[derive(Default)]
struct ExistingIds {
    live: IndexSet<String>,
    deleted: Vec<String>,
}

async fn get_existing_ids(user: &MaskedUser, ids: &[String]) -> anyhow::Result<ExistingIds> {
    let mut existing = ExistingIds::default();
    if ids.is_empty() {
        return Ok(existing);
    }
    let models = investment_transaction::TABLE
        .query(
            filters! { "user_id" => user.user_id.as_str() },
            SearchFilters {
                in_filters: vec![("investment_transaction_id".to_string(), ids.iter().map(|id| json!(id)).collect())],
                exclude_deleted: Some(false),
                ..Default::default()
            },
            None,
        )
        .await?;
    for m in &models {
        let id = str_of(m, "investment_transaction_id").to_string();
        if js::truthy_opt(m.get("is_deleted")) {
            existing.deleted.push(id);
        } else {
            existing.live.insert(id);
        }
    }
    Ok(existing)
}

/// The row to store for a planned one, built from its checked fields alone,
/// or why it can't be stored in this account. Anything else the client sent
/// is dropped, and every row is a manual one.
fn to_row(user: &MaskedUser, account_id: &str, planned: &Json) -> Result<QueryData, String> {
    let empty = Obj::new();
    let t = transaction_of(planned).unwrap_or(&empty);
    let field = |key: &str| t.get(key);
    let id = planned_id(planned);
    if !PLAN_STATEMENT_ID_PATTERN.is_match(id) {
        return Err(format!("{id} is not a plan statement row id"));
    }
    if field("account_id").and_then(Json::as_str) != Some(account_id) {
        return Err(format!("{id} belongs to another account"));
    }
    if !is_calendar_date_value(field("date")) {
        return Err(format!("{id} has no valid date"));
    }
    let is_cash_leg = id.ends_with("-cash");
    let kind = field("type").and_then(Json::as_str);
    let type_fits = if is_cash_leg {
        kind == Some("cash") && is_cash_subtype(field("subtype")) && field("security_id") == Some(&Json::Null)
    } else {
        matches!(kind, Some("buy" | "sell"))
            && is_share_subtype(field("subtype"))
            && matches!(field("security_id"), Some(Json::String(_)))
    };
    if !type_fits {
        return Err(format!("{id} has the wrong type, subtype or security"));
    }
    if !["amount", "quantity", "price"].iter().all(|key| is_finite_number(field(key))) {
        return Err(format!("{id} has a figure that isn't a number"));
    }
    if !matches!(field("name"), Some(Json::String(_))) {
        return Err(format!("{id} has an unreadable name"));
    }
    let currency = match field("iso_currency_code") {
        None | Some(Json::Null) => Json::Null,
        Some(currency) => currency.clone(),
    };
    let currency_fits = match &currency {
        Json::Null => true,
        Json::String(text) => js::js_length(text) <= MAX_CURRENCY_LENGTH,
        _ => false,
    };
    if !currency_fits {
        return Err(format!("{id} has an unreadable currency"));
    }
    let r = planned.get(RESTATED_FROM).filter(|r| js::truthy(r));
    if r.is_some()
        && (!matches!(prop(r, "investment"), Some(Json::String(_)))
            || !is_finite_number(prop(r, "units"))
            || !is_finite_number(prop(r, "unit_price")))
    {
        return Err(format!("{id} has an unreadable restatement"));
    }
    let d = planned.get(REINVESTED_DISTRIBUTION).filter(|d| js::truthy(d));
    if d.is_some()
        && (is_cash_leg
            || !is_calendar_date_value(prop(d, "ex_date"))
            || prop(d, "ex_date") != field("date")
            || !is_finite_number(prop(d, "cash_amount_per_share"))
            || !is_finite_number(prop(d, "shares_held")))
    {
        return Err(format!("{id} has an unreadable reinvestment"));
    }

    let mut tx = Obj::new();
    tx.insert("investment_transaction_id".into(), json!(id));
    tx.insert("account_id".into(), json!(account_id));
    for key in ["security_id", "date", "name", "amount", "quantity", "price"] {
        put(&mut tx, key, field(key));
    }
    tx.insert("iso_currency_code".into(), currency);
    put(&mut tx, "type", field("type"));
    put(&mut tx, "subtype", field("subtype"));
    tx.insert("source".into(), json!("manual"));
    let mut row = investment_transaction::from_json(&tx, &user.user_id);

    let raw = if r.is_some() {
        json!({ RESTATED_FROM: { "investment": prop(r, "investment"), "units": prop(r, "units"), "unit_price": prop(r, "unit_price") } })
    } else if d.is_some() {
        json!({
            REINVESTED_DISTRIBUTION: {
                "ex_date": prop(d, "ex_date"),
                "cash_amount_per_share": prop(d, "cash_amount_per_share"),
                "shares_held": prop(d, "shares_held"),
            }
        })
    } else {
        Json::Null
    };
    row.insert("raw".into(), raw);
    Ok(row)
}

/// The array a checked request field holds.
fn list_of<'a>(request: &'a Obj, key: &str) -> &'a [Json] {
    request.get(key).and_then(Json::as_array).map(Vec::as_slice).unwrap_or_default()
}

/// The holdings row of a holding's position after the import.
fn holding_of(account_id: &str, h: &Json) -> Obj {
    let amount = |key: &str| h.get(key).and_then(Json::as_f64).unwrap_or(f64::NAN);
    let security_id = text_of(h, "security_id");
    let mut holding = Obj::new();
    holding.insert("holding_id".into(), json!(format!("{account_id}-{security_id}")));
    holding.insert("account_id".into(), json!(account_id));
    holding.insert("security_id".into(), json!(security_id));
    put(&mut holding, "quantity", h.get("quantity"));
    put(&mut holding, "cost_basis", h.get("cost_basis"));
    put(&mut holding, "institution_price", h.get("price"));
    put(&mut holding, "institution_price_as_of", h.get("date"));
    holding.insert("institution_value".into(), js::num(amount("quantity") * amount("price")));
    holding.insert("iso_currency_code".into(), Json::Null);
    holding.insert("unofficial_currency_code".into(), Json::Null);
    holding
}

/// The id of a planned row; the route only lets non-empty strings through.
fn planned_id(planned: &Json) -> &str {
    transaction_of(planned).and_then(|t| t.get("investment_transaction_id")).and_then(Json::as_str).unwrap_or_default()
}

/// Stores what the import page planned from a plan statement, as the
/// account's owner. `Ok(Err(message))` is a refusal, the TypeScript's
/// `{ ok: false, message }`; `Err` is where it throws.
pub async fn import_plan_statement(requester: &MaskedUser, request: &Obj) -> anyhow::Result<Result<Json, String>> {
    let not_found = || Ok(Err("Account not found.".to_string()));
    let request_account_id = request.get("account_id").and_then(Json::as_str).unwrap_or_default();
    let transactions = list_of(request, "transactions");
    let request_mappings = list_of(request, "mappings");
    let replace: Vec<String> = list_of(request, "replace").iter().map(js::to_js_string).collect();
    let holdings = list_of(request, "holdings");

    // Everything the import stores belongs to the account's owner.
    let Some(user) = get_row_owner(requester, &account::TABLE, request_account_id).await? else { return not_found() };
    let Some(account) = get_account(&user, request_account_id).await? else { return not_found() };
    let item = get_item(&user, text_of(&account, "item_id")).await?;
    if account.get("type").and_then(Json::as_str) != Some("investment")
        || prop(item.as_ref(), "provider").and_then(Json::as_str) != Some("manual")
    {
        return Ok(Err("Plan statements can only be imported into a manual investment account.".to_string()));
    }
    let account_id = text_of(&account, "account_id").to_string();

    let mut built: IndexMap<String, QueryData> = IndexMap::new();
    for planned in transactions {
        let row = match to_row(&user, &account_id, planned) {
            Ok(row) => row,
            Err(problem) => return Ok(Err(problem)),
        };
        built.insert(planned_id(planned).to_string(), row);
    }

    let mut security_ids: IndexSet<String> = IndexSet::new();
    for planned in transactions {
        if let Some(security_id) = transaction_of(planned).and_then(|t| t.get("security_id")).filter(|id| js::truthy(id)) {
            security_ids.insert(js::to_js_string(security_id));
        }
    }
    security_ids.extend(request_mappings.iter().map(|m| text_of(m, "security_id").to_string()));
    security_ids.extend(replace.iter().cloned());
    security_ids.extend(holdings.iter().map(|h| text_of(h, "security_id").to_string()));
    let security_ids: Vec<String> = security_ids.into_iter().collect();
    let found: IndexSet<String> = search_securities_by_id(&security_ids)
        .await?
        .iter()
        .map(|security| security.get("security_id").map(js::to_js_string).unwrap_or_default())
        .collect();
    if let Some(missing) = security_ids.iter().find(|id| !found.contains(*id)) {
        return Ok(Err(format!("Security {missing} not found.")));
    }

    let planned_ids: Vec<String> = transactions.iter().map(|planned| planned_id(planned).to_string()).collect();
    let existing = get_existing_ids(&user, &planned_ids).await?;
    // The page holds only live rows, so it planned these as new: the shares and payouts it
    // derived from them are wrong. It plans again around them before anything is written.
    if !existing.deleted.is_empty() {
        return Ok(Ok(json!({ "written": 0, "alreadyImported": 0, "deleted": existing.deleted })));
    }
    let rows: Vec<QueryData> = built.into_iter().filter(|(id, _)| !existing.live.contains(id)).map(|(_, row)| row).collect();

    let mut mappings: IndexMap<String, Json> = IndexMap::new();
    for m in account.get("plan_fund_mappings").and_then(Json::as_array).map(Vec::as_slice).unwrap_or_default() {
        mappings.insert(m.get("investment").map(js::to_js_string).unwrap_or_else(|| "undefined".to_string()), m.clone());
    }
    for m in request_mappings {
        mappings.insert(text_of(m, "investment").to_string(), m.clone());
    }
    let mut saved = Obj::new();
    for (investment, mapping) in &mappings {
        let mut entry = Obj::new();
        put(&mut entry, "security_id", mapping.get("security_id"));
        put(&mut entry, "restated", mapping.get("restated"));
        saved.insert(investment.clone(), Json::Object(entry));
    }

    let written = rows.len();
    let (owner, into_account, holdings) = (user.clone(), account_id.clone(), holdings.to_vec());
    with_transaction(move |client| {
        Box::pin(async move {
            let client: &dyn Executor = client;
            for chunk in rows.chunks(INSERT_CHUNK_ROWS) {
                investment_transaction::TABLE.upsert_many(chunk, Some(&[]), Some(client)).await?;
            }
            let mut data = QueryData::new();
            data.insert("plan_fund_mappings".into(), Json::Object(saved));
            account::TABLE
                .update(
                    &json!(into_account),
                    &data,
                    UpdateArgs { user_id: Some(owner.user_id.as_str().into()), client: Some(client), ..Default::default() },
                )
                .await?;
            if !replace.is_empty() {
                let entered = get_holding_snapshots_for_securities(
                    &owner,
                    &into_account,
                    &replace,
                    HoldingSnapshotsForSecuritiesOptions { client: Some(client) },
                )
                .await?;
                let snapshot_ids: Vec<String> = entered.iter().map(|s| str_of(s, "snapshot_id").to_string()).collect();
                soft_delete_holding_snapshots(&owner, &snapshot_ids, Some(client)).await?;
            }
            for h in &holdings {
                upsert_holding_or_throw(&owner, &holding_of(&into_account, h), Some(client)).await?;
            }
            anyhow::Ok(())
        })
    })
    .await?;

    let mut first_dates: IndexMap<String, String> = IndexMap::new();
    for planned in transactions {
        let Some(t) = transaction_of(planned) else { continue };
        let Some(security_id) = t.get("security_id").filter(|id| js::truthy(id)) else { continue };
        let security_id = js::to_js_string(security_id);
        let date = t.get("date").map(js::to_js_string).unwrap_or_default();
        match first_dates.get(&security_id) {
            Some(first) if date >= *first => {}
            _ => {
                first_dates.insert(security_id, date);
            }
        }
    }
    let refs: Vec<BackfillSecurityRef> =
        first_dates.into_iter().map(|(security_id, from_date)| BackfillSecurityRef { security_id, from_date }).collect();
    tokio::spawn(async move {
        if let Err(error) = backfill_monthly_security_snapshots_forward(&refs, BackfillOptions::default()).await {
            logger::error(
                "backfillMonthlySecuritySnapshotsForward failed (plan statement)",
                Some(&crate::ctx! { "account_id": account_id }),
                Some(&error),
            );
        }
    });

    Ok(Ok(json!({ "written": written, "alreadyImported": existing.live.len() })))
}

#[cfg(test)]
mod tests {
    use super::*;

    // `post-plan-statement.test.ts`: the cases that check a planned row
    // without a database. What the import stores, and in which statements,
    // is covered by `conformance/tests/plan-statement.test.ts`.

    const ROW_ID: &str = "plan-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn owner() -> MaskedUser {
        MaskedUser { user_id: "usr-1".to_string(), username: "owner".to_string() }
    }

    fn with(mut value: Json, extra: Json) -> Json {
        if let (Some(object), Json::Object(extra)) = (value.as_object_mut(), extra) {
            object.extend(extra);
        }
        value
    }

    fn share_leg(extra: Json) -> Json {
        json!({
            "transaction": with(
                json!({
                    "investment_transaction_id": ROW_ID,
                    "account_id": "acct-1",
                    "security_id": "sec-index",
                    "date": "2026-03-02",
                    "name": "Buy (contribution)",
                    "amount": 1000,
                    "quantity": 20,
                    "price": 50,
                    "iso_currency_code": "USD",
                    "type": "buy",
                    "subtype": "contribution",
                    "source": "manual",
                }),
                extra,
            )
        })
    }

    fn cash_leg(extra: Json) -> Json {
        json!({
            "transaction": with(
                json!({
                    "investment_transaction_id": format!("{ROW_ID}-cash"),
                    "account_id": "acct-1",
                    "security_id": null,
                    "date": "2026-03-02",
                    "name": "Contribution",
                    "amount": -1000,
                    "quantity": 0,
                    "price": 0,
                    "iso_currency_code": "USD",
                    "type": "cash",
                    "subtype": "contribution",
                    "source": "manual",
                }),
                extra,
            )
        })
    }

    fn problem(planned: Json) -> String {
        to_row(&owner(), "acct-1", &planned).expect_err("the row should be refused")
    }

    #[test]
    fn stores_only_the_checked_fields_of_a_row_as_a_manual_row_of_the_owner() {
        let mut leg =
            share_leg(json!({ "source": "plaid", "label_memo": "x-memo", "label": { "budget_id": "x-budget" }, "raw": { "x": 1 } }));
        leg["restated_from"] = json!({ "investment": "T", "units": 2, "unit_price": 50, "x": 9 });
        let row = to_row(&owner(), "acct-1", &leg).unwrap();
        assert_eq!(
            Json::Object(row),
            json!({
                "user_id": "usr-1",
                "investment_transaction_id": ROW_ID,
                "account_id": "acct-1",
                "security_id": "sec-index",
                "date": "2026-03-02",
                "name": "Buy (contribution)",
                "amount": 1000,
                "quantity": 20,
                "price": 50,
                "iso_currency_code": "USD",
                "type": "buy",
                "subtype": "contribution",
                "source": "manual",
                "raw": { "restated_from": { "investment": "T", "units": 2, "unit_price": 50 } },
            })
        );
        let cash = to_row(&owner(), "acct-1", &cash_leg(json!({ "iso_currency_code": null }))).unwrap();
        assert_eq!(cash.get("security_id"), Some(&Json::Null));
        assert_eq!(cash.get("iso_currency_code"), Some(&Json::Null));
        assert_eq!(cash.get("raw"), Some(&Json::Null));
    }

    #[test]
    fn stores_what_a_reinvestment_was_inferred_from_on_its_share_leg() {
        let mut leg = share_leg(json!({ "subtype": "dividend reinvestment", "name": "Buy (dividend reinvestment)" }));
        leg["reinvested_distribution"] = json!({ "ex_date": "2026-03-02", "cash_amount_per_share": 0.5, "shares_held": 40, "x": 9 });
        let row = to_row(&owner(), "acct-1", &leg).unwrap();
        assert_eq!(
            row.get("raw"),
            Some(&json!({ "reinvested_distribution": { "ex_date": "2026-03-02", "cash_amount_per_share": 0.5, "shares_held": 40 } }))
        );
        // A falsy record is no record.
        for falsy in [json!(0), json!(""), json!(false), Json::Null] {
            let mut leg = share_leg(json!({}));
            leg["reinvested_distribution"] = falsy;
            assert_eq!(to_row(&owner(), "acct-1", &leg).unwrap().get("raw"), Some(&Json::Null));
        }
    }

    #[test]
    fn refuses_a_reinvestment_record_on_a_cash_leg_or_dated_off_its_row() {
        let record = json!({ "ex_date": "2026-03-02", "cash_amount_per_share": 0.5, "shares_held": 40 });
        let cases = [
            (cash_leg(json!({})), record.clone()),
            (share_leg(json!({})), with(record.clone(), json!({ "ex_date": "2026-03-03" }))),
            (share_leg(json!({})), with(record.clone(), json!({ "shares_held": "40" }))),
            (share_leg(json!({})), json!("2026-03-02")),
        ];
        for (mut leg, reinvested) in cases {
            leg["reinvested_distribution"] = reinvested;
            assert!(problem(leg).ends_with("has an unreadable reinvestment"));
        }
    }

    #[test]
    fn refuses_a_row_the_account_cannot_take() {
        for (leg, message) in [
            (share_leg(json!({ "investment_transaction_id": "manual-123" })), "manual-123 is not a plan statement row id".to_string()),
            (share_leg(json!({ "account_id": "acct-2" })), format!("{ROW_ID} belongs to another account")),
            (share_leg(json!({ "type": "cash" })), format!("{ROW_ID} has the wrong type, subtype or security")),
            (cash_leg(json!({ "security_id": "sec-index" })), format!("{ROW_ID}-cash has the wrong type, subtype or security")),
            (share_leg(json!({ "quantity": "20" })), format!("{ROW_ID} has a figure that isn't a number")),
            (share_leg(json!({ "subtype": "stock split" })), format!("{ROW_ID} has the wrong type, subtype or security")),
            (share_leg(json!({ "date": "2026-02-30" })), format!("{ROW_ID} has no valid date")),
            (share_leg(json!({ "date": "2026-13-01" })), format!("{ROW_ID} has no valid date")),
            (cash_leg(json!({ "subtype": "dividend reinvestment" })), format!("{ROW_ID}-cash has the wrong type, subtype or security")),
            (share_leg(json!({ "iso_currency_code": "DOLLARS-USD" })), format!("{ROW_ID} has an unreadable currency")),
            (share_leg(json!({ "name": null })), format!("{ROW_ID} has an unreadable name")),
        ] {
            assert_eq!(problem(leg), message);
        }
    }

    #[test]
    fn counts_a_currency_in_utf16_units_as_the_page_does() {
        assert!(to_row(&owner(), "acct-1", &share_leg(json!({ "iso_currency_code": "€€€€€€€€€€" }))).is_ok());
        assert!(to_row(&owner(), "acct-1", &share_leg(json!({ "iso_currency_code": "😀😀😀😀😀" }))).is_ok());
        assert_eq!(problem(share_leg(json!({ "iso_currency_code": "😀😀😀😀😀😀" }))), format!("{ROW_ID} has an unreadable currency"));
    }

    #[test]
    fn the_holdings_row_carries_the_position_and_its_value() {
        let h = json!({ "security_id": "sec-index", "date": "2026-03-02", "quantity": 2, "cost_basis": 100, "price": 50 });
        assert_eq!(
            Json::Object(holding_of("acct-1", &h)),
            json!({
                "holding_id": "acct-1-sec-index",
                "account_id": "acct-1",
                "security_id": "sec-index",
                "quantity": 2,
                "cost_basis": 100,
                "institution_price": 50,
                "institution_price_as_of": "2026-03-02",
                "institution_value": 100,
                "iso_currency_code": null,
                "unofficial_currency_code": null,
            })
        );
    }
}
