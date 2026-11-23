//! `GET /inflation`: `src/server/routes/charts/get-inflation.ts`.

use crate::js::Json;
use crate::server::inflation::get_average_inflation;
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};

/// Average annual inflation for the projection chart's auto goal
/// configuration; `null` until the scheduled refresh has stored at least a
/// year of CPI history. Reads `cpi_snapshots` only: BLS is reached solely by
/// the scheduled refresh, so no client request spends the API's daily quota.
async fn get_inflation(ctx: &mut Ctx) -> HandlerResult {
    if ctx.session.user.is_none() {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    }

    let body = get_average_inflation().await?;
    Ok(ApiResponse::success_with(body.unwrap_or(Json::Null)).into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("GET", "/inflation", get_inflation)]
}
