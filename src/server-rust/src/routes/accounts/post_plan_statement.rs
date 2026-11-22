//! `POST /plan-statement/import`: `src/server/routes/accounts/post-plan-statement.ts`.

use crate::common::date::is_calendar_date;
use crate::js::{Json, Obj};
use crate::server::plan_statement::import_plan_statement;
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Request, Route};
use crate::server::validation::{require_body_object, require_string_field, validation_error};

fn is_object(value: Option<&Json>) -> bool {
    matches!(value, Some(Json::Object(_)))
}

fn is_finite_number(value: Option<&Json>) -> bool {
    matches!(value, Some(Json::Number(n)) if n.as_f64().is_some_and(f64::is_finite))
}

fn is_non_empty_string(value: Option<&Json>) -> bool {
    matches!(value, Some(Json::String(text)) if !text.is_empty())
}

fn is_calendar_date_value(value: Option<&Json>) -> bool {
    matches!(value, Some(Json::String(text)) if is_calendar_date(text))
}

/// `isObject(value) ? value : {}`, for reading the fields of an entry that may be anything.
fn fields_of(value: &Json) -> Option<&Obj> {
    value.as_object()
}

/// The request the import takes, as JSON (see `server::plan_statement::import`),
/// or why the body isn't one.
fn parse_request(req: &Request) -> Result<Obj, String> {
    parse_body(require_body_object(req)?)
}

fn parse_body(body: &Obj) -> Result<Obj, String> {
    let account_id = require_string_field(body, "account_id")?;

    let Some(Json::Array(planned_rows)) = body.get("transactions") else {
        return Err("transactions must be an array".to_string());
    };
    let mut transactions = Vec::new();
    for planned in planned_rows {
        let transaction = planned.get("transaction");
        if !planned.is_object() || !is_object(transaction) {
            return Err("each transaction needs a transaction object".to_string());
        }
        let t = transaction.and_then(Json::as_object);
        let field = |key: &str| t.and_then(|t| t.get(key));
        if !is_non_empty_string(field("investment_transaction_id")) {
            return Err("each transaction needs an id".to_string());
        }
        if !is_calendar_date_value(field("date")) {
            return Err("each transaction needs a YYYY-MM-DD date".to_string());
        }
        if planned.get("restated_from").is_some_and(|r| !r.is_object()) {
            return Err("restated_from must be an object".to_string());
        }
        transactions.push(planned.clone());
    }

    let Some(Json::Array(entries)) = body.get("mappings") else {
        return Err("mappings must be an array".to_string());
    };
    let mut mappings = Vec::new();
    for m in entries {
        let m = fields_of(m);
        let field = |key: &str| m.and_then(|m| m.get(key));
        let (investment, security_id, restated) = (field("investment"), field("security_id"), field("restated"));
        if !is_non_empty_string(investment) {
            return Err("each mapping needs an investment".to_string());
        }
        if !is_non_empty_string(security_id) {
            return Err("each mapping needs a security_id".to_string());
        }
        let Some(Json::Bool(restated)) = restated else {
            return Err("mapping restated must be a boolean".to_string());
        };
        let mut mapping = Obj::new();
        mapping.insert("investment".into(), investment.cloned().unwrap_or_default());
        mapping.insert("security_id".into(), security_id.cloned().unwrap_or_default());
        mapping.insert("restated".into(), Json::Bool(*restated));
        mappings.push(Json::Object(mapping));
    }

    let replace = match body.get("replace") {
        None | Some(Json::Null) => Vec::new(),
        Some(Json::Array(ids)) if ids.iter().all(|id| is_non_empty_string(Some(id))) => ids.clone(),
        Some(_) => return Err("replace must be an array of security ids".to_string()),
    };

    let Some(Json::Array(entries)) = body.get("holdings") else {
        return Err("holdings must be an array".to_string());
    };
    let mut holdings = Vec::new();
    for h in entries {
        let h = fields_of(h);
        let field = |key: &str| h.and_then(|h| h.get(key));
        let (security_id, date, quantity, cost_basis, price) =
            (field("security_id"), field("date"), field("quantity"), field("cost_basis"), field("price"));
        if !is_non_empty_string(security_id) {
            return Err("each holding needs a security_id".to_string());
        }
        if !is_calendar_date_value(date) {
            return Err("each holding needs a YYYY-MM-DD date".to_string());
        }
        if !is_finite_number(quantity)
            || !is_finite_number(price)
            || (cost_basis != Some(&Json::Null) && !is_finite_number(cost_basis))
        {
            return Err("each holding needs a quantity, a price and a cost basis or null".to_string());
        }
        let mut holding = Obj::new();
        for (key, value) in [("security_id", security_id), ("date", date), ("quantity", quantity), ("cost_basis", cost_basis), ("price", price)] {
            holding.insert(key.into(), value.cloned().unwrap_or_default());
        }
        holdings.push(Json::Object(holding));
    }

    let mut request = Obj::new();
    request.insert("account_id".into(), Json::String(account_id));
    request.insert("transactions".into(), Json::Array(transactions));
    request.insert("mappings".into(), Json::Array(mappings));
    request.insert("replace".into(), Json::Array(replace));
    request.insert("holdings".into(), Json::Array(holdings));
    Ok(request)
}

/// Body: `{ account_id, transactions: [{ transaction, restated_from?, reinvested_distribution? }],
/// mappings: [{ investment, security_id, restated }], replace?: [security_id],
/// holdings: [{ security_id, date, quantity, cost_basis, price }] }`.
///
/// Stores the rows the import page planned from a plan statement. Rows
/// already in the account are left as they are. When any planned row was
/// deleted from the account, nothing is stored and their ids come back as
/// `deleted`, for the page to plan again around them.
async fn post_plan_statement_import(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };
    let request = match parse_request(&ctx.req) {
        Ok(request) => request,
        Err(message) => return Ok(validation_error(message).into()),
    };
    match import_plan_statement(&user, &request).await? {
        Ok(result) => Ok(ApiResponse::success_with(result).into()),
        Err(message) => Ok(ApiResponse::failed(message).into()),
    }
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("POST", "/plan-statement/import", post_plan_statement_import)]
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    // `post-plan-statement.test.ts`: the malformed bodies, which are refused
    // before anything is looked up.

    fn parse(body: Json) -> Result<Obj, String> {
        parse_body(body.as_object().expect("a test body is an object"))
    }

    fn holding() -> Json {
        json!({ "security_id": "sec-index", "date": "2026-03-02", "quantity": 2, "cost_basis": 100, "price": 50 })
    }

    #[test]
    fn rejects_a_malformed_body() {
        for (body, message) in [
            (json!({ "account_id": "acct-1" }), "transactions must be an array"),
            (json!({ "account_id": "acct-1", "transactions": "x", "mappings": [], "holdings": [] }), "transactions must be an array"),
            (
                json!({ "account_id": "acct-1", "transactions": [], "mappings": [{ "investment": "", "security_id": "s", "restated": false }], "holdings": [] }),
                "each mapping needs an investment",
            ),
            (
                json!({ "account_id": "acct-1", "transactions": [], "mappings": [], "holdings": [{ "security_id": "s", "date": "2026-03-02", "quantity": 1 }] }),
                "each holding needs a quantity, a price and a cost basis or null",
            ),
            (json!({ "account_id": "acct-1", "transactions": [], "mappings": [], "holdings": [], "replace": [1] }), "replace must be an array of security ids"),
            (json!({ "transactions": [] }), "Missing required field: account_id"),
            (json!({ "account_id": "a", "transactions": [{ "transaction": { "investment_transaction_id": "x", "date": "2026-03-02" }, "restated_from": null }] }), "restated_from must be an object"),
        ] {
            assert_eq!(parse(body).unwrap_err(), message);
        }
    }

    #[test]
    fn refuses_a_holding_dated_off_the_calendar() {
        for date in ["2026-02-30", "2026-13-01", "2026-00-10", "2026-03-32"] {
            let mut h = holding();
            h["date"] = json!(date);
            let body = json!({ "account_id": "acct-1", "transactions": [], "mappings": [], "holdings": [h] });
            assert_eq!(parse(body).unwrap_err(), "each holding needs a YYYY-MM-DD date");
        }
    }

    #[test]
    fn keeps_the_planned_rows_whole_and_only_the_fields_of_mappings_and_holdings() {
        let planned = json!({ "transaction": { "investment_transaction_id": "x", "date": "2026-03-02", "extra": 1 }, "reinvested_distribution": 5 });
        let mut extra_holding = holding();
        extra_holding["extra"] = json!(true);
        let body = json!({
            "account_id": "acct-1",
            "transactions": [planned],
            "mappings": [{ "investment": "Fund", "security_id": "sec-index", "restated": true, "extra": 1 }],
            "holdings": [extra_holding],
            "extra": "dropped",
        });
        assert_eq!(
            Json::Object(parse(body).unwrap()),
            json!({
                "account_id": "acct-1",
                "transactions": [planned],
                "mappings": [{ "investment": "Fund", "security_id": "sec-index", "restated": true }],
                "replace": [],
                "holdings": [holding()],
            })
        );
        // A null replacement is none; a cost basis may be null.
        let mut h = holding();
        h["cost_basis"] = Json::Null;
        let body = json!({ "account_id": "", "transactions": [], "mappings": [], "replace": null, "holdings": [h] });
        assert_eq!(parse(body).unwrap().get("replace"), Some(&json!([])));
    }
}
