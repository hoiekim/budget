//! `DELETE /api-keys`: `src/server/routes/api-keys/delete-api-key.ts`.

use serde_json::json;

use crate::server::postgres::repositories::api_keys::revoke_api_key;
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::require_query_string;

/// Revokes one of the caller's own keys.
async fn delete_api_key(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.user().cloned() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let key_id = match require_query_string(&ctx.req, "key_id") {
        Ok(key_id) => key_id,
        Err(message) => return Ok(ApiResponse::failed(message).into()),
    };

    let revoked = revoke_api_key(&key_id, &user.user_id).await?;
    if !revoked {
        return Ok(ApiResponse::failed("Key not found or already revoked.").into());
    }
    Ok(ApiResponse::success_with(json!({ "revoked": true })).into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("DELETE", "/api-keys", delete_api_key)]
}
