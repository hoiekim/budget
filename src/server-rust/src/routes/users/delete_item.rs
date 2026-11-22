//! `DELETE /item`: `src/server/routes/users/delete-item.ts`.

use crate::server::plaid;
use crate::server::postgres::repositories::items::{self, search_items, SearchItemsOptions};
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::{require_query_string, validation_error};

/// Removes a connection: at Plaid first, for a Plaid item, then here with its
/// accounts and everything in them.
async fn delete_item(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let item_id = match require_query_string(&ctx.req, "id") {
        Ok(item_id) => item_id,
        Err(message) => return Ok(validation_error(message).into()),
    };

    let items = search_items(&user, SearchItemsOptions::default()).await?;
    let Some(item) = items.iter().find(|item| item.get("item_id").and_then(|id| id.as_str()) == Some(item_id.as_str())) else {
        return Ok(ApiResponse::failed("Specified item is not owned by the request user").into());
    };

    // Without Plaid credentials the remote revocation can't run: the item is
    // still deleted here, since there is nothing reachable to clean up.
    if item.get("provider").and_then(|provider| provider.as_str()) == Some("plaid") && plaid::is_plaid_configured() {
        plaid::delete_item(&user, item).await?;
    }

    items::delete_item(&user, &item_id).await?;

    Ok(ApiResponse::success().into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("DELETE", "/item", delete_item)]
}
