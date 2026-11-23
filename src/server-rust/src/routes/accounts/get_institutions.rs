//! `GET /institutions`: `src/server/routes/accounts/get-institutions.ts`.

use crate::js::{Json, Obj};
use crate::server::logger;
use crate::server::plaid;
use crate::server::postgres::repositories::institutions::{search_institutions_by_id, upsert_institutions};
use crate::server::rate_limit::INSTITUTION_FALLBACK_RATE_LIMITER;
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::{js_trim, require_query_string, validation_error};

/// The request's downstream cost is linear in the id list, and the caller
/// chooses its length.
const MAX_REQUESTED_IDS: usize = 100;

/// Batch institution fetch: takes a CSV `ids=<a>,<b>,<c>` and answers the
/// institutions it resolves, in no promised order (callers index by
/// `institution_id`).
///
/// Plaid is asked for any requested id that is not stored. Plaid has no batch
/// endpoint for institutions, so that fallback is a fan-out over the misses;
/// `institutions` is a global table with no owner column, so any string the
/// caller invents reaches it. It is bounded on three axes: ids per request,
/// Plaid round trips per user per minute, and round trips in flight
/// process-wide.
///
/// A fallback failure omits that one id rather than failing the response: one
/// unresolvable institution shouldn't blank every other institution's logo
/// and name on the same render pass.
async fn get_institutions(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let ids = match require_query_string(&ctx.req, "ids") {
        Ok(ids) => ids,
        Err(message) => return Ok(validation_error(message).into()),
    };

    let parsed: Vec<&str> = ids.split(',').map(js_trim).filter(|id| !id.is_empty() && *id != "Unknown").collect();
    if parsed.len() > MAX_REQUESTED_IDS {
        return Ok(validation_error(format!("Parameter ids accepts at most {MAX_REQUESTED_IDS} institution ids per request")).into());
    }

    // Deduplicated before the miss set, not only inside the repository: a
    // repeated unresolvable id costs one Plaid round trip per copy otherwise.
    let mut requested: Vec<String> = Vec::new();
    for id in parsed {
        if !requested.iter().any(|seen| seen == id) {
            requested.push(id.to_string());
        }
    }
    if requested.is_empty() {
        return Ok(ApiResponse::success_with(Json::Array(Vec::new())).into());
    }

    let stored = search_institutions_by_id(&requested).await?;
    let stored_ids: Vec<&Json> = stored.iter().filter_map(|institution| institution.get("institution_id")).collect();
    let missing: Vec<String> =
        requested.into_iter().filter(|id| !stored_ids.iter().any(|stored| stored.as_str() == Some(id.as_str()))).collect();

    if missing.is_empty() {
        return Ok(ApiResponse::success_with(Json::Array(stored)).into());
    }

    if !plaid::is_plaid_configured() {
        // No credentials, so the Plaid fallback can't run. Answer what is
        // stored rather than failing the whole render pass.
        return Ok(ApiResponse::success_with(Json::Array(stored)).into());
    }

    let budget = INSTITUTION_FALLBACK_RATE_LIMITER.remaining(&user.user_id).max(0) as usize;
    let fetchable: Vec<String> = missing.iter().take(budget).cloned().collect();
    if fetchable.len() < missing.len() {
        logger::warn(
            "Institution Plaid-fallback capped by the per-user rate limit",
            Some(&crate::ctx! { "userId": user.user_id, "missing": missing.len(), "allowed": fetchable.len() }),
            None,
        );
    }
    if fetchable.is_empty() {
        // Shedding the whole request would blank every institution the user
        // does have, over a cap it did nothing to earn.
        return Ok(ApiResponse::success_with(Json::Array(stored)).into());
    }

    INSTITUTION_FALLBACK_RATE_LIMITER.consume(&user.user_id, fetchable.len() as i64);
    let fetched = plaid::get_institutions_by_ids(&user, &fetchable).await?;

    if !fetched.is_empty() {
        // Off the latency path: only the next request's read depends on the
        // rows landing. A failed write is logged by `upsert_institutions`.
        let rows: Vec<Obj> = fetched.iter().filter_map(|institution| institution.as_object().cloned()).collect();
        tokio::spawn(async move {
            upsert_institutions(&rows, None).await;
        });
    }

    let mut body = stored;
    body.extend(fetched);
    Ok(ApiResponse::success_with(Json::Array(body)).into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("GET", "/institutions", get_institutions)]
}
