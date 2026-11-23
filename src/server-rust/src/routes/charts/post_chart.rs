//! `POST /chart`: `src/server/routes/charts/post-chart.ts`.

use crate::server::logger;
use crate::server::postgres::repositories::charts::update_chart;
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::{require_body_object, require_string_field, validate_fields, validation_error, FieldSpec, FieldType};

/// Typed fields `update_chart` writes (`models/chart.rs`). `configuration` is
/// JSONB and the write side accepts a string or an object, but the client
/// always sends JSON text: pinned to the client's shape so a raw object
/// can't drift in unnoticed.
const CHART_BODY_SPEC: &[FieldSpec] = &[
    FieldSpec::new("chart_id", FieldType::Uuid),
    FieldSpec::new("name", FieldType::String).nullable().max_length(255),
    FieldSpec::new("type", FieldType::String).nullable().max_length(50),
    FieldSpec::new("configuration", FieldType::String),
];

async fn post_chart(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let body = match require_body_object(&ctx.req) {
        Ok(body) => body.clone(),
        Err(message) => return Ok(validation_error(message).into()),
    };
    let chart_id = match require_string_field(&body, "chart_id") {
        Ok(chart_id) => chart_id,
        Err(message) => return Ok(validation_error(message).into()),
    };
    if let Err(message) = validate_fields(&body, CHART_BODY_SPEC) {
        return Ok(validation_error(message).into());
    }

    let mut data = body;
    data.shift_remove("chart_id");

    match update_chart(&user, &chart_id, &data).await {
        Ok(_) => Ok(ApiResponse::success().into()),
        Err(error) => {
            logger::error("Failed to update chart", Some(&crate::ctx! { "chartId": chart_id }), Some(&error));
            Err(error)
        }
    }
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("POST", "/chart", post_chart)]
}
