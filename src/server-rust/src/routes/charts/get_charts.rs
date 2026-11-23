//! `GET /charts`: `src/server/routes/charts/get-charts.ts`.

use crate::js::Json;
use crate::server::postgres::repositories::charts::search_charts;
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};

async fn get_charts(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let body = search_charts(&user, None, None).await?;

    Ok(ApiResponse::success_with(Json::Array(body)).into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("GET", "/charts", get_charts)]
}
