//! `DELETE /recurrings`: `src/server/routes/recurrings/delete-recurring.ts`.

use crate::server::postgres::models::recurring;
use crate::server::postgres::repositories::recurrings::{dismiss_recurring, RecurringConfirmResult};
use crate::server::postgres::repositories::sharing::get_row_owner;
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::{require_query_string, validation_error};

/// `DELETE /recurrings?id=<recurring_id>`: the user's "this isn't right"
/// action on a suggested-or-confirmed recurring. Goes through
/// `dismiss_recurring`, which sets `status='dismissed'` (not
/// `is_deleted=TRUE`): the engine remembers the dismissal and won't re-suggest
/// THIS merchant group, but the transactions stay eligible for other
/// recurrings. Soft-deletion is reserved for the system cascade (when every
/// member transaction is removed).
async fn dismiss_recurring_route(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.user().cloned() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let id = match require_query_string(&ctx.req, "id") {
        Ok(id) => id,
        Err(message) => return Ok(validation_error(message).into()),
    };

    let owner = get_row_owner(&user, &recurring::TABLE, &id).await?.unwrap_or(user);
    Ok(match dismiss_recurring(&owner, &id).await? {
        RecurringConfirmResult::Ok => ApiResponse::success(),
        RecurringConfirmResult::Failed { error } => ApiResponse::failed(error),
    }
    .into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("DELETE", "/recurrings", dismiss_recurring_route)]
}
