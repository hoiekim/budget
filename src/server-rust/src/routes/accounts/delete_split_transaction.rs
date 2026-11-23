//! `DELETE /split-transaction`: `src/server/routes/accounts/delete-split-transaction.ts`.

use crate::server::postgres::repositories::split_transactions::delete_split_transactions;
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::{require_query_string, validate_fields, validation_error, FieldSpec, FieldType};

async fn delete_split_transaction(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let id = match require_query_string(&ctx.req, "id") {
        Ok(id) => id,
        Err(message) => return Ok(validation_error(message).into()),
    };
    // `id` becomes a UUID-column predicate below: a malformed value is
    // refused here (a failed answer, no alarm) instead of failing inside
    // Postgres with 22P02.
    if let Err(message) = validate_fields(&ctx.req.query_json(), &[FieldSpec::new("id", FieldType::Uuid).required()]) {
        return Ok(validation_error(message).into());
    }

    let deleted = delete_split_transactions(&user, std::slice::from_ref(&id), None).await?;
    if deleted.deleted == 0 {
        return Ok(ApiResponse::failed("Split transaction not found.").into());
    }

    Ok(ApiResponse::success().into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("DELETE", "/split-transaction", delete_split_transaction)]
}
