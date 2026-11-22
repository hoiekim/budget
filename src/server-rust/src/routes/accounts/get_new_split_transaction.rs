//! `GET /new-split-transaction`: `src/server/routes/accounts/get-new-split-transaction.ts`.

use serde_json::json;

use crate::server::postgres::models::transaction;
use crate::server::postgres::repositories::sharing::get_row_owner;
use crate::server::postgres::repositories::split_transactions::{create_split_transaction, CreateSplitTransactionInput};
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::{require_query_string, validation_error};

/// Mints a split of a transaction, owned by whoever owns the transaction.
async fn get_new_split_transaction(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let transaction_id = match require_query_string(&ctx.req, "transaction_id") {
        Ok(id) => id,
        Err(message) => return Ok(validation_error(message).into()),
    };
    let account_id = match require_query_string(&ctx.req, "account_id") {
        Ok(id) => id,
        Err(message) => return Ok(validation_error(message).into()),
    };

    let Some(owner) = get_row_owner(&user, &transaction::TABLE, &transaction_id).await? else {
        return Ok(ApiResponse::failed("Transaction not found.").into());
    };

    let created = create_split_transaction(&owner, &CreateSplitTransactionInput { transaction_id, account_id }).await?;

    Ok(ApiResponse::success_with(json!({ "split_transaction_id": created.get("split_transaction_id") })).into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("GET", "/new-split-transaction", get_new_split_transaction)]
}
