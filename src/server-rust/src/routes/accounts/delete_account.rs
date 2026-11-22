//! `DELETE /account`: `src/server/routes/accounts/delete-account.ts`.

use crate::server::postgres::repositories::accounts::{delete_accounts, search_accounts_by_id};
use crate::server::postgres::repositories::items::get_item;
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::{require_query_string, validation_error};

/// Deletes a manual account and everything in it. A provider's accounts come
/// back on its next sync, so only manual ones can be deleted.
async fn delete_account(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let account_id = match require_query_string(&ctx.req, "id") {
        Ok(account_id) => account_id,
        Err(message) => return Ok(validation_error(message).into()),
    };

    let accounts = search_accounts_by_id(&user, std::slice::from_ref(&account_id)).await?;
    let Some(account) = accounts.into_iter().next() else {
        return Ok(ApiResponse::failed("Account not found.").into());
    };

    let item_id = account.get("item_id").and_then(|item_id| item_id.as_str()).unwrap_or_default();
    let Some(item) = get_item(&user, item_id).await? else {
        return Ok(ApiResponse::failed("Item not found.").into());
    };

    if item.get("provider").and_then(|provider| provider.as_str()) != Some("manual") {
        return Ok(ApiResponse::failed("Account is not a manual account.").into());
    }

    // `delete_accounts` soft-deletes what the account holds: transactions,
    // investment and split transactions, snapshots and holdings.
    delete_accounts(&user, &[account_id]).await?;

    Ok(ApiResponse::success().into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("DELETE", "/account", delete_account)]
}
