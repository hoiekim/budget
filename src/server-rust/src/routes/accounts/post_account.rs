//! `POST /account`: `src/server/routes/accounts/post-account.ts`.

use serde_json::json;

use crate::server::logger;
use crate::server::postgres::repositories::accounts::update_accounts;
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::{
    require_body_object, require_string_field, validate_fields, validation_error, FieldSpec, FieldType, DECIMAL_15_2_MAX,
};

/// The typed fields an edit can set, mirroring their column types in
/// `models/account.rs`. Each is nullable there, so an explicit null clears the
/// column rather than failing. `account_id` is checked separately
/// (`require_string_field`) because it is the only required one; `item_id` and
/// `institution_id` are absent because `update_accounts` strips them, not
/// because they are nullable: both columns are `NOT NULL`.
const ACCOUNT_BODY_SPEC: &[FieldSpec] = &[
    FieldSpec::new("name", FieldType::String).nullable().max_length(255),
    FieldSpec::new("type", FieldType::String).nullable().max_length(50),
    FieldSpec::new("subtype", FieldType::String).nullable().max_length(100),
    FieldSpec::new("custom_name", FieldType::String).nullable(),
    FieldSpec::new("hide", FieldType::Boolean).nullable(),
    FieldSpec::new("archived", FieldType::Boolean).nullable(),
    FieldSpec::new("label.budget_id", FieldType::Uuid).nullable(),
    FieldSpec::new("balances.available", FieldType::Number).nullable().max(DECIMAL_15_2_MAX),
    FieldSpec::new("balances.current", FieldType::Number).nullable().max(DECIMAL_15_2_MAX),
    FieldSpec::new("balances.limit", FieldType::Number).nullable().max(DECIMAL_15_2_MAX),
    FieldSpec::new("balances.iso_currency_code", FieldType::String).nullable().max_length(10),
    FieldSpec::new("graphOptions.useSnapshots", FieldType::Boolean).nullable(),
    FieldSpec::new("graphOptions.useHoldingSnapshots", FieldType::Boolean).nullable(),
    FieldSpec::new("graphOptions.useTransactions", FieldType::Boolean).nullable(),
];

/// Edits an existing account. Purely an update: create lives on the sibling
/// `GET /new-account` route, so a body naming an `account_id` that does not
/// exist answers `Account not found.` instead of a no-op that looks like
/// success. `item_id` and `institution_id` are create-only and stripped in
/// `update_accounts`.
async fn post_account(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let body = match require_body_object(&ctx.req) {
        Ok(body) => body.clone(),
        Err(message) => return Ok(validation_error(message).into()),
    };
    let account_id = match require_string_field(&body, "account_id") {
        Ok(account_id) => account_id,
        Err(message) => return Ok(validation_error(message).into()),
    };
    if let Err(message) = validate_fields(&body, ACCOUNT_BODY_SPEC) {
        return Ok(validation_error(message).into());
    }

    let error = match update_accounts(&user, &[body]).await.into_iter().next() {
        Some(updated) if updated.status == 200 => {
            if !updated.id.is_empty() {
                return Ok(ApiResponse::success_with(json!({ "account_id": updated.id })).into());
            }
            anyhow::anyhow!("Account ID is missing after write")
        }
        Some(updated) if updated.status == 304 => return Ok(ApiResponse::failed("Account not found.").into()),
        Some(updated) => anyhow::anyhow!("Account update did not persist, status {}", updated.status),
        None => anyhow::anyhow!("Account update did not persist, status missing"),
    };
    logger::error("Failed to update account", Some(&crate::ctx! { "accountId": account_id }), Some(&error));
    Err(error)
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("POST", "/account", post_account)]
}
