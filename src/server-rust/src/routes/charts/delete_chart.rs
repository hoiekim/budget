//! `DELETE /chart`: `src/server/routes/charts/delete-chart.ts`.

use crate::server::postgres::repositories::charts;
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::{require_query_string, validate_fields, validation_error, FieldSpec, FieldType};

async fn delete_chart(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let chart_id = match require_query_string(&ctx.req, "id") {
        Ok(chart_id) => chart_id,
        Err(message) => return Ok(validation_error(message).into()),
    };
    // `id` becomes a UUID-column predicate: a malformed value is refused
    // here instead of failing inside Postgres.
    if let Err(message) = validate_fields(&ctx.req.query_json(), &[FieldSpec::new("id", FieldType::Uuid).required()]) {
        return Ok(validation_error(message).into());
    }

    charts::delete_chart(&user, &chart_id).await?;

    Ok(ApiResponse::success().into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("DELETE", "/chart", delete_chart)]
}
