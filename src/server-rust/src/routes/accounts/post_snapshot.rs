//! `POST /snapshot`: `src/server/routes/accounts/post-snapshot.ts`.

use serde_json::json;

use crate::common::date::get_squashed_date_string;
use crate::js::{JsDate, Json, Obj};
use crate::server::postgres::models::account;
use crate::server::postgres::repositories::sharing::get_row_owner;
use crate::server::postgres::repositories::snapshots::upsert_snapshots;
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::{
    optional_date_field, require_body_object, validate_fields, validation_error, FieldSpec, FieldType, DECIMAL_15_2_MAX,
};

/// The typed fields an account snapshot can carry, mirroring their columns
/// in `models/snapshot.rs` (BALANCES_AVAILABLE / CURRENT / LIMIT
/// DECIMAL(15, 2), BALANCES_ISO_CURRENCY_CODE VARCHAR(10)). All four are
/// nullable, so an explicit null clears the column rather than failing.
/// Checked before the ownership lookup: a client type error is a `failed`
/// answer with the field named, never an error at the write that the route
/// layer turns into a 500 and an alarm. `account.balances` itself is
/// optional: absent leaves nothing to check, and the write side defaults each
/// balance to null. The bounds mirror the columns, so an overflowing balance
/// is refused here with the limit named.
const SNAPSHOT_BODY_SPEC: &[FieldSpec] = &[
    FieldSpec::new("account.balances.available", FieldType::Number).nullable().max(DECIMAL_15_2_MAX),
    FieldSpec::new("account.balances.current", FieldType::Number).nullable().max(DECIMAL_15_2_MAX),
    FieldSpec::new("account.balances.limit", FieldType::Number).nullable().max(DECIMAL_15_2_MAX),
    FieldSpec::new("account.balances.iso_currency_code", FieldType::String).nullable().max_length(10),
];

/// Records an account's balance for a day: the day given, or today. Answers
/// the snapshot's id and the date actually stored, as an ISO string. Both
/// derive from the server's local midnight, so a client that echoed its own
/// reading of the date into its cache would disagree with the next sync
/// whenever the browser and the server sit in different zones.
async fn post_snapshot(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let body = match require_body_object(&ctx.req) {
        Ok(body) => body.clone(),
        Err(message) => return Ok(validation_error(message).into()),
    };

    let Some(Json::Object(snapshot_data)) = body.get("snapshot") else {
        return Ok(validation_error("Request body must contain snapshot data").into());
    };

    // TODO: Snapshot can be holding or security snapshot as well
    let account = match body.get("account") {
        Some(Json::Object(account)) if account.get("account_id").is_some_and(Json::is_string) => account,
        _ => return Ok(validation_error("Request body must contain an account with an account_id").into()),
    };
    let account_id = account.get("account_id").and_then(Json::as_str).unwrap_or_default().to_string();

    if let Err(message) = validate_fields(&body, SNAPSHOT_BODY_SPEC) {
        return Ok(validation_error(message).into());
    }

    let Some(owner) = get_row_owner(&user, &account::TABLE, &account_id).await? else {
        return Ok(ApiResponse::failed("Account not found or access denied.").into());
    };

    let date = match optional_date_field(snapshot_data, "date", Some("snapshot.date")) {
        Ok(date) => date.unwrap_or_else(JsDate::now),
        Err(message) => return Ok(validation_error(message).into()),
    };
    let snapshot_id = format!("{account_id}-{}", get_squashed_date_string(date));
    let date = date.to_json();

    let mut new_snapshot = Obj::new();
    new_snapshot.insert("user".into(), json!({ "user_id": owner.user_id }));
    new_snapshot.insert("snapshot".into(), json!({ "snapshot_id": snapshot_id, "date": date }));
    new_snapshot.insert("account".into(), Json::Object(account.clone()));

    // A failed write is logged by `upsert_snapshots` and still answers the id.
    let response = upsert_snapshots(&[new_snapshot]).await;
    let snapshot_id = response.first().map(|result| result.id.clone()).unwrap_or_default();
    Ok(ApiResponse::success_with(json!({ "snapshot_id": snapshot_id, "date": date })).into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("POST", "/snapshot", post_snapshot)]
}
