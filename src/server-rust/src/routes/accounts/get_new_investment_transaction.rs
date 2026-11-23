//! `GET /new-investment-transaction`: `src/server/routes/accounts/get-new-investment-transaction.ts`.

use serde_json::json;

use crate::js::{num, to_js_string, to_number, Json, Obj};
use crate::server::postgres::models::account;
use crate::server::postgres::repositories::accounts::get_account;
use crate::server::postgres::repositories::investment_transactions::{
    create_manual_investment_transaction, CreateManualInvestmentTransactionInput,
};
use crate::server::postgres::repositories::securities::get_security;
use crate::server::postgres::repositories::sharing::get_row_owner;
use crate::server::route::{ApiResponse, Ctx, HandlerResult, QueryValue, Route};
use crate::server::validation::{require_query_string, validate_fields, validation_error, FieldSpec, FieldType, DECIMAL_15_6_MAX};

/// Plaid's `AccountType.Investment`.
const INVESTMENT_ACCOUNT_TYPE: &str = "investment";
/// Plaid's `InvestmentTransactionType.Buy` and `.Sell`: the two types that move shares.
const BUY: &str = "buy";
const SELL: &str = "sell";

/// The caller-supplied mint values, validated before any query. `date` is
/// calendar-checked (2026-02-30 is refused); `iso_currency_code` is capped at
/// the VARCHAR(10) column; `price` / `quantity` are bounded to the
/// DECIMAL(15, 6) range rather than merely finite, since 1e300 is finite but
/// overflows the column. Price has no direction (min 0); quantity may be
/// negative (a reconciliation sale). All four are optional: absent values
/// fall back to the mint defaults.
const NEW_INVESTMENT_TRANSACTION_QUERY_SPEC: &[FieldSpec] = &[
    FieldSpec::new("date", FieldType::Date),
    FieldSpec::new("iso_currency_code", FieldType::String).max_length(10),
    FieldSpec::new("price", FieldType::Number).min(0.0).max(DECIMAL_15_6_MAX),
    FieldSpec::new("quantity", FieldType::Number).min(-DECIMAL_15_6_MAX).max(DECIMAL_15_6_MAX),
];

/// A query parameter that is present and not empty (a repeated one is an array, and truthy).
fn given<'a>(ctx: &'a Ctx, param: &str) -> Option<&'a QueryValue> {
    ctx.req.query.get(param).filter(|value| !matches!(value, QueryValue::One(text) if text.is_empty()))
}

/// `String(value)` of a query parameter: a repeated one joins its values with commas.
fn query_text(value: &QueryValue) -> String {
    to_js_string(&value.to_json())
}

/// `Number(value)` of a query parameter.
fn query_number(value: &QueryValue) -> f64 {
    to_number(&query_text(value))
}

/// Mints a shell manual `investment_transactions` row. Unlike
/// `GET /new-transaction`, this is NOT gated on `items.provider === MANUAL`:
/// the motivating case (RSU/ESPP grants that predate Plaid's 24-month window)
/// lives on a Plaid-connected brokerage account. Plaid sync writes rows keyed
/// by its own ids, so the `manual-<uuid>` prefix has no collision surface,
/// and `source='manual'` keeps the intent auditable.
async fn get_new_investment_transaction(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let account_id = match require_query_string(&ctx.req, "account_id") {
        Ok(id) => id,
        Err(message) => return Ok(validation_error(message).into()),
    };

    // Validate the mint values BEFORE any query: each of the four reaches a
    // column that rejects it, and the write would fail with a 500 and an
    // alarm. Absent (or empty) values stay absent and fall back to the mint
    // defaults; only present values are collected, so `validate_fields`
    // skips the rest the way it skips absent optionals.
    let date = given(ctx, "date");
    let iso_currency_code = given(ctx, "iso_currency_code");
    let price = given(ctx, "price").map(query_number);
    let quantity = given(ctx, "quantity").map(query_number);
    let mut query_values = Obj::new();
    if let Some(date) = date {
        query_values.insert("date".into(), date.to_json());
    }
    if let Some(code) = iso_currency_code {
        query_values.insert("iso_currency_code".into(), code.to_json());
    }
    if let Some(price) = price {
        query_values.insert("price".into(), num(price));
    }
    if let Some(quantity) = quantity {
        query_values.insert("quantity".into(), num(quantity));
    }
    if let Err(message) = validate_fields(&query_values, NEW_INVESTMENT_TRANSACTION_QUERY_SPEC) {
        return Ok(validation_error(message).into());
    }
    // Validated above: each is a single string now.
    let date = date.map(query_text);
    let iso_currency_code = iso_currency_code.map(query_text);

    let Some(account) = get_account(&user, &account_id).await? else {
        return Ok(ApiResponse::failed("Account not found.").into());
    };
    // Match the client: the `Add Investment Transaction` button only renders
    // on investment accounts, so a direct-URL caller can't mint an
    // investment_transactions row against a depository or credit account
    // either (the row wouldn't render as a holding, but the data would still
    // be wrong).
    if account.get("type").and_then(Json::as_str) != Some(INVESTMENT_ACCOUNT_TYPE) {
        return Ok(ApiResponse::failed("Investment transactions can only be created on investment accounts.").into());
    }

    // `security_id` is optional: omitted from the account-level button, where
    // the user picks the security in the detail form, and prefilled from the
    // per-security `+` on the holding detail page. When present it must name
    // a real security: the column has no foreign key, and a garbage id would
    // later break the client's security lookups.
    let security_id = match given(ctx, "security_id").map(query_text) {
        Some(raw) => {
            if get_security(&raw).await?.is_none() {
                return Ok(ApiResponse::failed("Security not found.").into());
            }
            Some(raw)
        }
        None => None,
    };

    // `price` and `iso_currency_code` come prefilled from the holding, so the
    // shell starts with values the user can confirm rather than a 0 that
    // quietly zeroes the money-weighted return if abandoned. `quantity` is
    // prefilled when the client knows the exact missing units (the divergence
    // flag's "Add transaction for N missing units"), and `date` with the
    // earliest holdings-snapshot date that shows the surplus, so the mint
    // explains the shares from that date forward. The caller reconciles the
    // row it asks for, so a negative quantity arrives already named as a
    // sale. Only the two types that move shares are accepted: the others are
    // reached by editing the row afterwards.
    let r#type = match given(ctx, "type").map(query_text).as_deref() {
        Some(SELL) => Some(SELL.to_string()),
        Some(BUY) => Some(BUY.to_string()),
        _ => None,
    };

    let Some(owner) = get_row_owner(&user, &account::TABLE, &account_id).await? else {
        return Ok(ApiResponse::failed("Account not found.").into());
    };

    let input = CreateManualInvestmentTransactionInput {
        account_id,
        security_id,
        price,
        iso_currency_code,
        quantity,
        r#type,
        date,
    };
    let Some(created) = create_manual_investment_transaction(&owner, &input).await? else {
        return Ok(ApiResponse::failed("Failed to create investment transaction.").into());
    };

    Ok(ApiResponse::success_with(json!({
        "investment_transaction_id": created.get("investment_transaction_id"),
        "name": created.get("name"),
    }))
    .into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("GET", "/new-investment-transaction", get_new_investment_transaction)]
}
