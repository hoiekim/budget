//! `src/server/lib/postgres/repositories/investment_transactions.ts`.

use std::borrow::Cow;

use serde_json::json;

use super::transactions::{date_range, id_context, id_of, next_unknown_index, utc_today, Deleted};
use crate::filters;
use crate::js::{math_round, num, number_to_string, Json, Obj};
use crate::server::logger;
use crate::server::postgres::client::{pool, Executor};
use crate::server::postgres::database::{error_result, no_change_result, success_result, QueryData, SearchFilters, UpsertResult};
use crate::server::postgres::models::{investment_transaction, MaskedUser, UpdateArgs};

/// Plaid's `InvestmentTransactionType.Buy` and `InvestmentTransactionSubtype.Buy`.
const BUY: &str = "buy";
/// Plaid's `InvestmentTransactionType.Sell` and `InvestmentTransactionSubtype.Sell`.
const SELL: &str = "sell";

#[derive(Clone, Debug, Default)]
pub struct SearchInvestmentTransactionsOptions {
    pub account_id: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// A (partial) `JSONInvestmentTransaction` that names its `investment_transaction_id`.
pub type PartialInvestmentTransaction = Obj;

pub async fn get_investment_transactions(user: &MaskedUser, options: &SearchInvestmentTransactionsOptions) -> anyhow::Result<Vec<Json>> {
    let mut filters = filters! { "user_id" => user.user_id.as_str() };
    if let Some(account_id) = &options.account_id {
        filters.extend(filters! { "account_id" => account_id.as_str() });
    }
    let models = investment_transaction::TABLE
        .query(
            filters,
            SearchFilters {
                date_range: date_range("date", options.start_date.as_deref(), options.end_date.as_deref()),
                order_by: Some("date DESC".to_string()),
                limit: options.limit,
                offset: options.offset,
                ..Default::default()
            },
            None,
        )
        .await?;
    Ok(models.iter().map(investment_transaction::to_json).collect())
}

pub async fn get_investment_transaction(user: &MaskedUser, investment_transaction_id: &str) -> anyhow::Result<Option<Json>> {
    let model = investment_transaction::TABLE
        .query_one(filters! { "user_id" => user.user_id.as_str(), "investment_transaction_id" => investment_transaction_id })
        .await?;
    Ok(model.map(|row| investment_transaction::to_json(&row)))
}

/// Never fails: a transaction that cannot be written is logged and reported with status 500.
pub async fn upsert_investment_transactions(user: &MaskedUser, transactions: &[Obj], client: Option<&dyn Executor>) -> Vec<UpsertResult> {
    let mut results = Vec::new();

    for tx in transactions {
        let id = id_of(tx, "investment_transaction_id");
        let row = investment_transaction::from_json(tx, &user.user_id);
        match investment_transaction::TABLE.upsert(&row, None, client).await {
            Ok(_) => results.push(success_result(&id, Some(1))),
            Err(error) => {
                logger::error(
                    "Failed to upsert investment transaction",
                    Some(&id_context("investmentTransactionId", tx, "investment_transaction_id")),
                    Some(&error),
                );
                results.push(error_result(&id));
            }
        }
    }
    results
}

/// Drops `source` from an update: nothing resets it, so a row relabelled
/// `manual` stays relabelled and starts being reconciled, and one provider
/// signs a movement positive when money arrives, turning its withdrawals into
/// deposits. The route's spec cannot express this; `validate_fields` checks the
/// fields it names rather than rejecting the ones it does not.
fn without_provenance(patch: &PartialInvestmentTransaction) -> Cow<'_, PartialInvestmentTransaction> {
    if !patch.contains_key("source") {
        return Cow::Borrowed(patch);
    }
    Cow::Owned(patch.iter().filter(|(key, _)| key.as_str() != "source").map(|(key, value)| (key.clone(), value.clone())).collect())
}

/// The columns an update of `tx` sets: never its id, its owner or its origin.
fn update_row(tx: &PartialInvestmentTransaction, user_id: &str) -> QueryData {
    let mut row = investment_transaction::from_json(&without_provenance(tx), user_id);
    row.shift_remove("investment_transaction_id");
    row.shift_remove("user_id");
    row
}

/// Never fails: a transaction that cannot be written is logged and reported with status 500.
pub async fn update_investment_transactions(user: &MaskedUser, transactions: &[PartialInvestmentTransaction]) -> Vec<UpsertResult> {
    let mut results = Vec::new();

    for tx in transactions {
        let id = id_of(tx, "investment_transaction_id");
        let row = update_row(tx, &user.user_id);

        // Scope the update to the caller's user_id: without this a
        // caller could patch another user's investment transaction by id.
        // Soft-deleted rows keep their primary key but are invisible to every
        // read. Updating one would report a change no user can see; excluding
        // them here keeps "update" and "reachable" in agreement.
        let updated = investment_transaction::TABLE
            .update(
                tx.get("investment_transaction_id").unwrap_or(&Json::Null),
                &row,
                UpdateArgs { user_id: Some(&user.user_id), exclude_deleted: Some(true), ..Default::default() },
            )
            .await;
        match updated {
            Ok(Some(_)) => results.push(success_result(&id, Some(1))),
            Ok(None) => results.push(no_change_result(&id)),
            Err(error) => {
                logger::error(
                    "Failed to update investment transaction",
                    Some(&id_context("investmentTransactionId", tx, "investment_transaction_id")),
                    Some(&error),
                );
                results.push(error_result(&id));
            }
        }
    }
    results
}

/// Same shape as `next_unknown_tx_index` in `transactions.rs`: see that comment
/// for the rationale on the "count soft-deleted" choice.
async fn next_inv_unknown_index(user_id: &str) -> anyhow::Result<f64> {
    let sql = "SELECT COALESCE(MAX(CAST(SUBSTRING(name FROM '^Unknown_(\\d+)$') AS INTEGER)), 0) AS max \
               FROM investment_transactions WHERE user_id = $1 AND name ~ '^Unknown_[0-9]+$'";
    let result = pool().query(sql, &[json!(user_id)]).await?;
    Ok(next_unknown_index(result.rows.first()))
}

#[derive(Clone, Debug, Default)]
pub struct CreateManualInvestmentTransactionInput {
    pub account_id: String,
    pub security_id: Option<String>,
    /// Holding-derived defaults. When the mint is triggered from the
    /// holding detail page, the caller passes the holding's
    /// `institution_price` and `iso_currency_code` so the shell starts
    /// with a plausible non-zero price the user can confirm/correct.
    /// From the account-level `+` (no holding context) these are
    /// omitted and fall back to 0 / null.
    pub price: Option<f64>,
    pub iso_currency_code: Option<String>,
    pub quantity: Option<f64>,
    /// Stored as sent: the caller reconciles the row it is asking for.
    pub r#type: Option<String>,
    /// YYYY-MM-DD. Defaults to today when omitted.
    pub date: Option<String>,
}

/// `Math.round(value * 100) / 100`. A value that rounds to zero from below
/// stays the negative zero it is in JS, so the database is sent the number
/// the TypeScript sends it.
fn round_to_cents(value: f64) -> f64 {
    let cents = value * 100.0;
    let rounded = math_round(cents);
    (if rounded == 0.0 && cents.is_sign_negative() { -0.0 } else { rounded }) / 100.0
}

fn manual_investment_transaction_row(
    user_id: &str,
    input: &CreateManualInvestmentTransactionInput,
    investment_transaction_id: &str,
    index: f64,
    today: &str,
) -> QueryData {
    let quantity = input.quantity.unwrap_or(0.0);
    let price = input.price.unwrap_or(0.0);
    // Derive `amount = quantity × price` when the caller provided both. The
    // TransactionsPage view filters out zero-amount investment rows, so a mint
    // that prefills only quantity (the divergence "N missing units" action)
    // would land the row in DB but invisible in the tx list. Deriving here
    // keeps the row visible without requiring the FE to re-POST the amount
    // after the shell insert.
    let amount = round_to_cents(quantity * price);
    let r#type = input.r#type.as_deref().unwrap_or(BUY);
    let mut tx = Obj::new();
    tx.insert("investment_transaction_id".into(), json!(investment_transaction_id));
    tx.insert("account_id".into(), json!(input.account_id));
    tx.insert("security_id".into(), json!(input.security_id));
    tx.insert("date".into(), json!(input.date.as_deref().unwrap_or(today)));
    tx.insert("name".into(), json!(format!("Unknown_{}", number_to_string(index))));
    tx.insert("amount".into(), num(amount));
    tx.insert("quantity".into(), num(quantity));
    tx.insert("price".into(), num(price));
    tx.insert("iso_currency_code".into(), json!(input.iso_currency_code));
    tx.insert("type".into(), json!(r#type));
    tx.insert("subtype".into(), json!(if r#type == SELL { SELL } else { BUY }));
    tx.insert("source".into(), json!("manual"));
    investment_transaction::from_json(&tx, user_id)
}

/// Inserts a shell `investment_transactions` row. Unlike the cash-side
/// `create_manual_transaction`, this is NOT gated on
/// `items.provider === MANUAL`: the motivating case (RSU/ESPP grants
/// that predate Plaid's 24-month window) lives on a Plaid-connected
/// brokerage account. Plaid sync only inserts/updates rows keyed by its
/// own IDs, so a manual UUID-shaped id has no collision surface.
/// `None` when the row could not be written.
pub async fn create_manual_investment_transaction(
    user: &MaskedUser,
    input: &CreateManualInvestmentTransactionInput,
) -> anyhow::Result<Option<Json>> {
    let investment_transaction_id = format!("manual-{}", uuid::Uuid::new_v4());
    let index = next_inv_unknown_index(&user.user_id).await?;
    let row = manual_investment_transaction_row(&user.user_id, input, &investment_transaction_id, index, &utc_today());
    let created = async {
        let Some(result) = investment_transaction::TABLE.insert(&row, Some(&["*"]), false).await? else { return Ok(None) };
        anyhow::Ok(Some(investment_transaction::to_json(&investment_transaction::TABLE.validate(result)?)))
    };
    match created.await {
        Ok(created) => Ok(created),
        Err(error) => {
            logger::error(
                "Failed to create manual investment transaction",
                Some(&crate::ctx! { "investment_transaction_id": investment_transaction_id, "account_id": input.account_id }),
                Some(&error),
            );
            Ok(None)
        }
    }
}

pub async fn delete_investment_transactions(
    user: &MaskedUser,
    transaction_ids: &[String],
    client: Option<&dyn Executor>,
) -> anyhow::Result<Deleted> {
    if transaction_ids.is_empty() {
        return Ok(Deleted { deleted: 0 });
    }
    let ids: Vec<Json> = transaction_ids.iter().map(|id| json!(id)).collect();
    let deleted = investment_transaction::TABLE.bulk_soft_delete(&ids, &[("user_id", json!(user.user_id))], client).await?;
    Ok(Deleted { deleted })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::transactions::testing::{obj, user, FakeExecutor};
    use super::*;
    use crate::server::postgres::database::{build_insert, build_update, AdditionalWhere, UpdateOptions};

    const ID: &str = "itx-1";

    /// A written statement as the columns it set paired with the values it
    /// bound, by placeholder number: both statements carry columns that are
    /// not parameters (`updated = CURRENT_TIMESTAMP`).
    fn bound(columns_and_expressions: Vec<(&str, &str)>, values: &[Json]) -> Obj {
        columns_and_expressions
            .into_iter()
            .filter_map(|(column, expression)| {
                let number: usize = expression.trim().strip_prefix('$')?.parse().ok()?;
                Some((column.trim().to_string(), values[number - 1].clone()))
            })
            .collect()
    }

    /// The row a mint with `input` inserts.
    fn inserted(input: CreateManualInvestmentTransactionInput) -> Obj {
        let row = manual_investment_transaction_row("usr-1", &input, "manual-1", 1.0, "2026-11-21");
        let query = build_insert("investment_transactions", &row, &["*"], false);
        let columns = query.sql.split_once('(').unwrap().1.split_once(") VALUES (").unwrap();
        let expressions = columns.1.split_once(") RETURNING").unwrap().0;
        bound(columns.0.split(", ").zip(expressions.split(", ")).collect(), &query.values)
    }

    /// The columns the UPDATE for `patch` sets, or `None` when it is no statement.
    fn updated(patch: Json) -> Option<Obj> {
        let patch = obj(patch);
        let row = update_row(&patch, "usr-1");
        let options = UpdateOptions {
            additional_where: &[AdditionalWhere::new("user_id", "usr-1")],
            returning: &["investment_transaction_id"],
            exclude_deleted: true,
        };
        let query = build_update("investment_transactions", "investment_transaction_id", &json!(ID), &row, &options)?;
        let clause = query.sql.split_once(" SET ").unwrap().1.split_once(" WHERE ").unwrap().0;
        Some(bound(clause.split(", ").filter_map(|part| part.split_once(" = ")).collect(), &query.values))
    }

    // The mint stores the row it is asked for. Reconciling the four shape fields
    // is the caller's job (it is the only party that knows which field the user
    // touched), so the type arrives named rather than being worked out twice, once
    // here and once for the caller's own optimistic copy.
    // "createManualInvestmentTransaction"

    #[test]
    fn the_callers_type_is_stored_so_a_sale_is_not_minted_as_a_purchase() {
        let row = inserted(CreateManualInvestmentTransactionInput {
            account_id: "acc-1".into(),
            quantity: Some(-5.0),
            price: Some(30.0),
            r#type: Some("sell".into()),
            ..Default::default()
        });
        assert_eq!(row["type"], json!("sell"));
        assert_eq!(row["subtype"], json!("sell"));
        assert_eq!(row["quantity"], json!(-5));
        assert_eq!(row["amount"], json!(-150));
    }

    #[test]
    fn a_purchase_is_stored_as_one() {
        let row = inserted(CreateManualInvestmentTransactionInput {
            account_id: "acc-1".into(),
            quantity: Some(4.0),
            price: Some(25.0),
            r#type: Some("buy".into()),
            ..Default::default()
        });
        assert_eq!(row["type"], json!("buy"));
        assert_eq!(row["quantity"], json!(4));
        assert_eq!(row["amount"], json!(100));
    }

    // The account-level mint names no type, and a row has to start somewhere.
    #[test]
    fn a_caller_naming_no_type_gets_a_purchase() {
        let row = inserted(CreateManualInvestmentTransactionInput {
            account_id: "acc-1".into(),
            quantity: Some(2.0),
            price: Some(30.0),
            ..Default::default()
        });
        assert_eq!(row["type"], json!("buy"));
        assert_eq!(row["subtype"], json!("buy"));
        assert_eq!(row["amount"], json!(60));
    }

    #[test]
    fn a_mint_with_nothing_but_an_account_is_a_zero_purchase_dated_today() {
        let input = CreateManualInvestmentTransactionInput { account_id: "acc-1".into(), ..Default::default() };
        let row = manual_investment_transaction_row("usr-1", &input, "manual-1", 12.0, "2026-11-21");
        assert_eq!(
            crate::js::json_stringify(&Json::Object(row)),
            r#"{"user_id":"usr-1","investment_transaction_id":"manual-1","account_id":"acc-1","security_id":null,"date":"2026-11-21","name":"Unknown_12","amount":0,"quantity":0,"price":0,"iso_currency_code":null,"type":"buy","subtype":"buy","source":"manual","raw":{"investment_transaction_id":"manual-1","account_id":"acc-1","security_id":null,"date":"2026-11-21","name":"Unknown_12","amount":0,"quantity":0,"price":0,"iso_currency_code":null,"type":"buy","subtype":"buy"}}"#
        );
    }

    #[test]
    fn the_amount_is_quantity_times_price_to_the_cent_and_the_date_is_the_callers() {
        let row = inserted(CreateManualInvestmentTransactionInput {
            account_id: "acc-1".into(),
            security_id: Some("sec-1".into()),
            quantity: Some(1.5),
            price: Some(10.333),
            iso_currency_code: Some("USD".into()),
            date: Some("2025-01-02".into()),
            ..Default::default()
        });
        // 1.5 × 10.333 × 100 = 1549.95, which rounds to 1550.
        assert_eq!(row["amount"], json!(15.5));
        assert_eq!(row["quantity"], json!(1.5));
        assert_eq!(row["price"], json!(10.333));
        assert_eq!(row["date"], json!("2025-01-02"));
        assert_eq!(row["security_id"], json!("sec-1"));
        assert_eq!(row["iso_currency_code"], json!("USD"));
        assert_eq!(row["source"], json!("manual"));
    }

    #[test]
    fn rounding_to_cents_takes_halves_up_and_keeps_a_negative_zero() {
        assert_eq!(round_to_cents(1.005), 1.0);
        assert_eq!(round_to_cents(3.0 * 0.335), 1.01);
        assert_eq!(round_to_cents(-1.005), -1.0);
        assert_eq!(round_to_cents(-150.0), -150.0);
        for value in [-0.5 * 0.01, -0.001, -0.0] {
            let rounded = round_to_cents(value);
            assert!(rounded == 0.0 && rounded.is_sign_negative(), "{value}");
        }
        assert!(round_to_cents(0.004).is_sign_positive());
    }

    // A type other than the two that move shares is stored as sent, as a purchase's subtype.
    #[test]
    fn only_a_sale_gets_the_sale_subtype() {
        let row = inserted(CreateManualInvestmentTransactionInput {
            account_id: "acc-1".into(),
            r#type: Some("cash".into()),
            ..Default::default()
        });
        assert_eq!(row["type"], json!("cash"));
        assert_eq!(row["subtype"], json!("buy"));
    }

    // `source` records which writer produced a row, nothing resets it, and
    // normalization is scoped by it, so a patch able to set it would let a
    // provider row be relabelled permanently and rewritten from then on.
    // "updateInvestmentTransactions — provenance"

    #[test]
    fn a_patch_naming_source_does_not_write_it() {
        let row = updated(json!({ "investment_transaction_id": ID, "source": "manual", "quantity": 3 })).unwrap();
        assert!(!row.contains_key("source"));
        assert_eq!(row["quantity"], json!(3));
    }

    #[test]
    fn a_patch_naming_only_source_writes_nothing_in_its_place() {
        assert!(updated(json!({ "investment_transaction_id": ID, "source": "manual" })).is_none());
    }

    // Reconciling the four shape fields is the editor's job, because only it
    // knows which one the user just touched. What arrives is stored as sent.
    #[test]
    fn the_fields_a_patch_does_name_are_written_with_the_values_it_sent() {
        let row = updated(json!({ "investment_transaction_id": ID, "type": "sell", "quantity": -5, "amount": -150 })).unwrap();
        assert_eq!(row["type"], json!("sell"));
        assert_eq!(row["quantity"], json!(-5));
        assert_eq!(row["amount"], json!(-150));
    }

    #[test]
    fn a_patch_touching_none_of_the_shape_fields_leaves_every_one_of_them_alone() {
        let row = updated(json!({ "investment_transaction_id": ID, "label": { "memo": "note" } })).unwrap();
        for column in ["price", "amount", "quantity", "subtype", "type"] {
            assert!(!row.contains_key(column), "{column}");
        }
        assert_eq!(row["label_memo"], json!("note"));
    }

    #[test]
    fn a_patch_without_source_is_used_as_it_is() {
        let patch = obj(json!({ "investment_transaction_id": ID, "quantity": 3 }));
        assert!(matches!(without_provenance(&patch), Cow::Borrowed(_)));
        let patch = obj(json!({ "investment_transaction_id": ID, "source": null, "quantity": 3 }));
        assert_eq!(
            crate::js::json_stringify(&Json::Object(without_provenance(&patch).into_owned())),
            r#"{"investment_transaction_id":"itx-1","quantity":3}"#
        );
    }

    // Writes on the caller's transaction client.

    #[tokio::test]
    async fn upsert_reports_each_transaction_and_carries_on_past_a_failure() {
        let executor = FakeExecutor::new().failure("DB error");
        let transactions = [
            obj(json!({ "investment_transaction_id": "itx-bad", "account_id": "acc-1", "date": "2026-03-01" })),
            obj(json!({ "investment_transaction_id": "itx-good", "account_id": "acc-1", "date": "2026-03-01", "label": { "memo": "m" } })),
        ];
        let result = upsert_investment_transactions(&user("usr-1"), &transactions, Some(&executor)).await;
        assert_eq!((result[0].id.as_str(), result[0].status), ("itx-bad", 500));
        assert_eq!((result[1].id.as_str(), result[1].status), ("itx-good", 200));
        assert_eq!(
            executor.sql(1),
            "INSERT INTO investment_transactions (updated, user_id, investment_transaction_id, account_id, date, label_memo, raw) \
             VALUES (CURRENT_TIMESTAMP, $1, $2, $3, $4, $5, $6) \
             ON CONFLICT (investment_transaction_id) DO UPDATE SET user_id = EXCLUDED.user_id, account_id = EXCLUDED.account_id, \
             date = EXCLUDED.date, label_memo = EXCLUDED.label_memo, raw = EXCLUDED.raw, updated = CURRENT_TIMESTAMP RETURNING *"
        );

        let executor = FakeExecutor::new();
        assert!(upsert_investment_transactions(&user("usr-1"), &[], Some(&executor)).await.is_empty());
        assert!(executor.calls().is_empty());
    }

    #[tokio::test]
    async fn update_returns_empty_array_for_empty_input() {
        assert!(update_investment_transactions(&user("usr-1"), &[]).await.is_empty());
    }

    #[tokio::test]
    async fn delete_soft_deletes_the_users_rows_by_id_on_the_given_client() {
        let executor = FakeExecutor::new().count(1);
        let ids = ["itx-1".to_string()];
        assert_eq!(delete_investment_transactions(&user("usr-1"), &ids, Some(&executor)).await.unwrap(), Deleted { deleted: 1 });
        assert_eq!(
            executor.calls(),
            vec![(
                "UPDATE investment_transactions SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE investment_transaction_id IN ($1) AND user_id = $2 RETURNING investment_transaction_id".to_string(),
                vec![json!("itx-1"), json!("usr-1")],
            )]
        );

        let executor = FakeExecutor::new();
        assert_eq!(delete_investment_transactions(&user("usr-1"), &[], Some(&executor)).await.unwrap(), Deleted { deleted: 0 });
        assert!(executor.calls().is_empty());
    }
}
