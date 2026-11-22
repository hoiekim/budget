//! `GET /new-transaction`: `src/server/routes/accounts/get-new-transaction.ts`.

use serde_json::json;

use crate::server::postgres::models::account;
use crate::server::postgres::repositories::accounts::get_account;
use crate::server::postgres::repositories::items::get_item;
use crate::server::postgres::repositories::sharing::get_row_owner;
use crate::server::postgres::repositories::transactions::{create_manual_transaction, CreateManualTransactionInput};
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::{require_query_string, validation_error};

/// `ItemProvider.MANUAL`.
const MANUAL_PROVIDER: &str = "manual";

/// Mints a shell manual `transactions` row on a manual account. The client
/// navigates to the transaction's detail page for the returned id, whose
/// save-on-blur handlers fill in the fields. Gated to
/// `items.provider === MANUAL` so a duplicate row is never created on a
/// Plaid-synced account.
async fn get_new_transaction(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let account_id = match require_query_string(&ctx.req, "account_id") {
        Ok(id) => id,
        Err(message) => return Ok(validation_error(message).into()),
    };

    let Some(account) = get_account(&user, &account_id).await? else {
        return Ok(ApiResponse::failed("Account not found.").into());
    };

    let item_id = account.get("item_id").and_then(|id| id.as_str()).unwrap_or_default();
    let Some(item) = get_item(&user, item_id).await? else {
        return Ok(ApiResponse::failed("Item not found.").into());
    };
    if item.get("provider").and_then(|provider| provider.as_str()) != Some(MANUAL_PROVIDER) {
        return Ok(ApiResponse::failed("Manual transaction entry is only allowed on manual accounts.").into());
    }

    let Some(owner) = get_row_owner(&user, &account::TABLE, &account_id).await? else {
        return Ok(ApiResponse::failed("Account not found.").into());
    };

    let iso_currency_code = account
        .get("balances")
        .and_then(|balances| balances.get("iso_currency_code"))
        .and_then(|code| code.as_str())
        .map(str::to_string);
    let created = create_manual_transaction(&owner, &CreateManualTransactionInput { account_id, iso_currency_code }).await?;
    let Some(created) = created else {
        return Ok(ApiResponse::failed("Failed to create transaction.").into());
    };

    Ok(ApiResponse::success_with(json!({
        "transaction_id": created.get("transaction_id"),
        "name": created.get("name"),
    }))
    .into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("GET", "/new-transaction", get_new_transaction)]
}
