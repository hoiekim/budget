//! `GET /api-keys`: `src/server/routes/api-keys/get-api-keys.ts`.

use serde_json::json;

use crate::server::postgres::repositories::api_keys::list_api_keys;
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};

/// The caller's keys that are not revoked, newest first, without their hashes.
async fn get_api_keys(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.user() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };
    let keys = list_api_keys(&user.user_id).await?;
    Ok(ApiResponse::success_with(json!({ "api_keys": keys })).into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("GET", "/api-keys", get_api_keys)]
}
