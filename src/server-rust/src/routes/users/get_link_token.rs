//! `GET /link-token`: `src/server/routes/users/get-link-token.ts`.

use crate::server::plaid;
use crate::server::postgres::repositories::items::get_item;
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::{optional_query_string, validation_error};

/// A Plaid Link token: for a new connection, or, given `item_id`, for update
/// mode on that connection.
async fn get_link_token(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let item_id = match optional_query_string(&ctx.req, "item_id") {
        Ok(item_id) => item_id,
        Err(message) => return Ok(validation_error(message).into()),
    };

    // The browser names the item; the server resolves the stored credential
    // itself. The lookup is scoped to the requesting user and whoever shares
    // data with them, so a caller can never mint an update-mode link token for
    // a stranger's item.
    let mut access_token: Option<String> = None;
    if let Some(item_id) = item_id {
        let Some(item) = get_item(&user, &item_id).await? else {
            return Ok(ApiResponse::failed("Item not found.").into());
        };
        access_token = item.get("access_token").and_then(|token| token.as_str()).map(str::to_string);
    }

    if !plaid::is_plaid_configured() {
        return Ok(ApiResponse::failed("Plaid integration is not configured on this server.").into());
    }

    let response = plaid::get_link_token(&user, access_token.as_deref()).await?;
    if !crate::js::truthy(&response) {
        anyhow::bail!("Server failed to get link token.");
    }

    Ok(match response.get("link_token") {
        Some(link_token) => ApiResponse::success_with(link_token.clone()),
        None => ApiResponse::success(),
    }
    .into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("GET", "/link-token", get_link_token)]
}
