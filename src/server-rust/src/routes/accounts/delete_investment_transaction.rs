//! `DELETE /investment-transaction`: `src/server/routes/accounts/delete-investment-transaction.ts`.

use serde_json::json;

use crate::server::postgres::repositories::investment_transactions::{delete_investment_transactions, get_investment_transaction};
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::{require_query_string, validation_error};

/// Soft-deletes a single manual investment transaction: the Delete button of
/// a `source='manual'` row's detail page. A stray `Add Investment
/// Transaction` click leaves a zero-quantity, zero-price row that would
/// clutter the transactions list forever without this.
///
/// Gated to `source='manual'`: Plaid rows are sync-owned, and a manual
/// delete would come back on the next incremental sync.
async fn delete_investment_transaction(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let investment_transaction_id = match require_query_string(&ctx.req, "id") {
        Ok(id) => id,
        Err(message) => return Ok(validation_error(message).into()),
    };

    let Some(tx) = get_investment_transaction(&user, &investment_transaction_id).await? else {
        return Ok(ApiResponse::failed("Investment transaction not found.").into());
    };
    if tx.get("source").and_then(|source| source.as_str()) != Some("manual") {
        return Ok(ApiResponse::failed("Only manual investment transactions can be deleted from the detail page.").into());
    }

    let deleted = delete_investment_transactions(&user, std::slice::from_ref(&investment_transaction_id), None).await?;
    if deleted.deleted == 0 {
        return Ok(ApiResponse::failed("Failed to delete investment transaction.").into());
    }
    Ok(ApiResponse::success_with(json!({ "investment_transaction_id": investment_transaction_id })).into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("DELETE", "/investment-transaction", delete_investment_transaction)]
}
