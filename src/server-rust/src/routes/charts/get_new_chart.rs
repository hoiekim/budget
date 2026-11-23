//! `GET /new-chart`: `src/server/routes/charts/get-new-chart.ts`.

use serde_json::json;

use crate::js::{Json, Obj};
use crate::server::postgres::repositories::charts::create_chart;
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};

/// Creates a chart with the defaults and answers with its id alone.
async fn get_new_chart(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let Some(response) = create_chart(&user, &Obj::new()).await? else {
        return Ok(ApiResponse::failed("Failed to create chart.").into());
    };
    let chart_id = response.get("chart_id").cloned().unwrap_or(Json::Null);
    Ok(ApiResponse::success_with(json!({ "chart_id": chart_id })).into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("GET", "/new-chart", get_new_chart)]
}
