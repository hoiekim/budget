//! `GET /new-account`: `src/server/routes/accounts/get-new-account.ts`.

use serde_json::json;

use crate::js::Json;
use crate::server::postgres::models::item;
use crate::server::postgres::repositories::accounts::{create_manual_account, ManualAccountInput};
use crate::server::postgres::repositories::items::get_item;
use crate::server::postgres::repositories::sharing::get_row_owner;
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::{require_query_string, validation_error};

/// Mints a shell manual account on a manual item, which the client then lets
/// the user rename and retype. Gated to manual items so a caller can't mint
/// an account under a synced connection. The account belongs to whoever owns
/// the item, so it leaves a sharing group with the connection.
async fn get_new_account(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let item_id = match require_query_string(&ctx.req, "item_id") {
        Ok(item_id) => item_id,
        Err(message) => return Ok(validation_error(message).into()),
    };

    let Some(found) = get_item(&user, &item_id).await? else {
        return Ok(ApiResponse::failed("Item not found.").into());
    };
    if found.get("provider").and_then(|provider| provider.as_str()) != Some("manual") {
        return Ok(ApiResponse::failed("Manual accounts can only be created on manual items.").into());
    }

    let Some(owner) = get_row_owner(&user, &item::TABLE, &item_id).await? else {
        return Ok(ApiResponse::failed("Item not found.").into());
    };

    let Some(created) = create_manual_account(&owner, ManualAccountInput { item_id, ..Default::default() }).await else {
        return Ok(ApiResponse::failed("Failed to create account.").into());
    };

    let field = |key: &str| created.get(key).cloned().unwrap_or(Json::Null);
    Ok(ApiResponse::success_with(json!({ "account_id": field("account_id"), "name": field("name") })).into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("GET", "/new-account", get_new_account)]
}
