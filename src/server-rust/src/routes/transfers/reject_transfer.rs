//! `DELETE /transfers`: `src/server/routes/transfers/reject-transfer.ts`.

use crate::server::postgres::repositories::transfers::reject_transfer_pair;
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::{require_query_string, validate_fields, validation_error, FieldSpec, FieldType};

/// `id` names the `transaction_pairs.pair_id` `UUID PRIMARY KEY` column: a
/// non-UUID value handed to `WHERE pair_id = $1` raises Postgres `22P02
/// invalid input syntax for type uuid` at the read, throwing out of the route
/// (a 500 plus an alarm for a request the route could have refused).
/// `require_query_string` guarantees only a non-empty string, not a UUID, so
/// the shape check happens here.
const REJECT_TRANSFER_QUERY_SPEC: [FieldSpec; 1] = [FieldSpec::new("id", FieldType::Uuid).required()];

/// `DELETE /transfers?id=<pair_id>`: the user's "this isn't right" action on a
/// suggested-or-confirmed pair. Goes through `reject_transfer_pair`, which sets
/// `status='rejected'` (not `is_deleted=TRUE`): the engine remembers the
/// rejection and won't re-suggest THIS pair, but the two transactions remain
/// eligible for other counterparts. Soft-deletion is reserved for the system
/// cascade (when a transaction itself is removed).
async fn reject_transfer(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.user().cloned() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let id = match require_query_string(&ctx.req, "id") {
        Ok(id) => id,
        Err(message) => return Ok(validation_error(message).into()),
    };

    if let Err(message) = validate_fields(&ctx.req.query_json(), &REJECT_TRANSFER_QUERY_SPEC) {
        return Ok(validation_error(message).into());
    }

    reject_transfer_pair(&user, &id).await?;

    Ok(ApiResponse::success().into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("DELETE", "/transfers", reject_transfer)]
}
