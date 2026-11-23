//! `GET /accounts`: `src/server/routes/accounts/get-accounts.ts`.

use serde_json::json;

use crate::js::Json;
use crate::server::postgres::repositories::accounts::{search_accounts, SearchAccountsOptions};
use crate::server::postgres::repositories::holdings::get_holdings;
use crate::server::postgres::repositories::items::{search_items, to_client_item, SearchItemsOptions};
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};

/// The connections, accounts and holdings the user can see: their own and
/// those of everyone sharing data with them.
async fn get_accounts(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let (items, accounts, holdings) = futures::try_join!(
        search_items(&user, SearchItemsOptions::default()),
        search_accounts(&user, SearchAccountsOptions::default()),
        get_holdings(&user),
    )?;
    // Items carry the Plaid/SimpleFin credential server-side; the browser gets
    // the credential-free projection.
    let items: Vec<Json> = items.iter().map(to_client_item).collect();

    Ok(ApiResponse::success_with(json!({ "items": items, "accounts": accounts, "holdings": holdings })).into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("GET", "/accounts", get_accounts)]
}
