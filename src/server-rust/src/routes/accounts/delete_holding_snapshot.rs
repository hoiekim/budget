//! `DELETE /snapshots/holding`: `src/server/routes/accounts/delete-holding-snapshot.ts`.

use crate::server::logger;
use crate::server::postgres::repositories::snapshots::{delete_snapshot_by_id, get_holding_snapshot_by_id};
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::{require_query_string, validation_error};

async fn delete_holding_snapshot(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let snapshot_id = match require_query_string(&ctx.req, "id") {
        Ok(snapshot_id) => snapshot_id,
        Err(message) => return Ok(validation_error(message).into()),
    };

    // The by-id lookup is the ownership check: it is scoped to the user and
    // their sharing group, so a miss is "not found or access denied" without
    // fetching the whole list.
    if get_holding_snapshot_by_id(&user, snapshot_id.as_str()).await?.is_none() {
        return Ok(ApiResponse::failed("Snapshot not found or access denied.").into());
    }

    // The delete's answer is the truth: the row can vanish between the lookup
    // and the delete, and only the soft-delete's row count knows.
    match delete_snapshot_by_id(&user, &snapshot_id).await {
        Ok(true) => Ok(ApiResponse::success().into()),
        Ok(false) => Ok(ApiResponse::failed("Snapshot not found or access denied.").into()),
        Err(error) => {
            logger::error("Failed to delete holding snapshot", Some(&crate::ctx! { "snapshot_id": snapshot_id }), Some(&error));
            Err(error)
        }
    }
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("DELETE", "/snapshots/holding", delete_holding_snapshot)]
}
