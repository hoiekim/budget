//! `DELETE /transaction`: `src/server/routes/accounts/delete-transaction.ts`.

use serde_json::json;

use crate::server::postgres::repositories::transactions::{delete_transactions, get_transaction};
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::{require_query_string, validation_error};

/// Soft-deletes a single manual transaction: the Delete button of a
/// `source='manual'` row's detail page, the way to clean up an accidentally
/// minted shell (an abandoned `Add Transaction` click leaves a zero-amount row).
///
/// Gated to `source='manual'`: Plaid-synced rows are owned by the sync path
/// and are not user-deletable from the detail page (a manual delete would
/// resurface on the next sync via upsert-by-id anyway).
async fn delete_transaction(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let transaction_id = match require_query_string(&ctx.req, "id") {
        Ok(id) => id,
        Err(message) => return Ok(validation_error(message).into()),
    };

    let Some(tx) = get_transaction(&user, &transaction_id).await? else {
        return Ok(ApiResponse::failed("Transaction not found.").into());
    };
    if tx.get("source").and_then(|source| source.as_str()) != Some("manual") {
        return Ok(ApiResponse::failed("Only manual transactions can be deleted from the detail page.").into());
    }

    let deleted = delete_transactions(&user, std::slice::from_ref(&transaction_id), None).await?;
    if deleted.deleted == 0 {
        return Ok(ApiResponse::failed("Failed to delete transaction.").into());
    }
    Ok(ApiResponse::success_with(json!({ "transaction_id": transaction_id })).into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("DELETE", "/transaction", delete_transaction)]
}
