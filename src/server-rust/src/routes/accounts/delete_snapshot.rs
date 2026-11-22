//! `DELETE /snapshot`: `src/server/routes/accounts/delete-snapshot.ts`.

use crate::server::postgres::repositories::snapshots::delete_snapshot_by_id;
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::{require_query_string, validation_error};

/// Soft-deletes a snapshot of the user's or of someone sharing data with them.
async fn delete_snapshot(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let snapshot_id = match require_query_string(&ctx.req, "id") {
        Ok(snapshot_id) => snapshot_id,
        Err(message) => return Ok(validation_error(message).into()),
    };

    if !delete_snapshot_by_id(&user, &snapshot_id).await? {
        return Ok(ApiResponse::failed("Snapshot not found.").into());
    }

    Ok(ApiResponse::success().into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("DELETE", "/snapshot", delete_snapshot)]
}
