//! `GET /transfers`: `src/server/routes/transfers/get-transfers.ts`.

use serde_json::json;

use crate::js::{Json, Obj};
use crate::server::postgres::repositories::transfers::{get_transfer_pairs, GetTransferPairsOptions};
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::{optional_query_string, validate_fields, validation_error, FieldSpec, FieldType};

/// The transfer pairs of the user and of everyone sharing data with them.
async fn get_transfers(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.user().cloned() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    // Eviction-signal delivery is opt-in rather than hardcoded the way
    // /transactions and /snapshots do it, so a caller that has no cache to
    // reconcile (anything reading this endpoint for the current pair list)
    // isn't handed rows it would only have to filter back out. `useSync` opts
    // in on a warm sync and after a failed purge, not on a healthy cold load.
    let include_deleted = match optional_query_string(&ctx.req, "include-deleted") {
        Ok(value) => value,
        Err(message) => return Ok(validation_error(message).into()),
    };

    let start = match optional_query_string(&ctx.req, "start-date") {
        Ok(value) => value,
        Err(message) => return Ok(validation_error(message).into()),
    };
    // The parsed `start-date` becomes a TIMESTAMPTZ predicate below: a
    // malformed or non-calendar date is refused here instead of letting
    // Postgres raise 22007/22008 inside the route.
    let mut date_check = Obj::new();
    if let Some(start) = &start {
        date_check.insert("start-date".into(), Json::String(start.clone()));
    }
    if let Err(message) = validate_fields(&date_check, &[FieldSpec::new("start-date", FieldType::Date)]) {
        return Ok(validation_error(message).into());
    }

    let pairs = get_transfer_pairs(
        &user,
        GetTransferPairsOptions { include_deleted: include_deleted.as_deref() == Some("true"), start_date: start },
    )
    .await?;
    Ok(ApiResponse::success_with(json!(pairs)).into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("GET", "/transfers", get_transfers)]
}
