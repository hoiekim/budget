//! `GET /recurrings`: `src/server/routes/recurrings/get-recurrings.ts`.

use serde_json::json;

use crate::server::postgres::repositories::recurrings::{get_recurrings, GetRecurringsOptions};
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::{optional_query_string, validation_error};

/// The recurrings of the user and of everyone sharing data with them.
async fn get_recurrings_route(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.user().cloned() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    // Same opt-in eviction-signal contract as /transfers: `useSync` opts in
    // on a warm sync and after a failed purge, not on a healthy cold load.
    let include_deleted = match optional_query_string(&ctx.req, "include-deleted") {
        Ok(value) => value,
        Err(message) => return Ok(validation_error(message).into()),
    };

    let start = match optional_query_string(&ctx.req, "start-date") {
        Ok(value) => value,
        Err(message) => return Ok(validation_error(message).into()),
    };

    let recurrings = get_recurrings(
        &user,
        GetRecurringsOptions {
            include_deleted: include_deleted.as_deref() == Some("true"),
            start_date: start,
            recurring_ids: None,
        },
    )
    .await?;
    Ok(ApiResponse::success_with(json!(recurrings)).into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("GET", "/recurrings", get_recurrings_route)]
}
