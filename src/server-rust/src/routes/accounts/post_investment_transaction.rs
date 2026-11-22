//! `POST /investment-transaction`: `src/server/routes/accounts/post-investment-transaction.ts`.

use serde_json::json;

use crate::server::logger;
use crate::server::postgres::repositories::investment_transactions::update_investment_transactions;
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::{
    require_body_object, require_string_field, validate_fields, validation_error, FieldSpec, FieldType, DECIMAL_15_2_MAX,
    DECIMAL_15_6_MAX,
};

/// Typed fields `investment_transaction::from_json` copies into a row
/// (`models/investment_transaction.rs`). `label.budget_id` and
/// `label.category_id` land in `UUID` columns on this table too, so they are
/// guarded even though the numeric trio is the headline; explicit null is
/// how the client clears a label.
const INVESTMENT_TRANSACTION_BODY_SPEC: &[FieldSpec] = &[
    FieldSpec::new("amount", FieldType::Number).max(DECIMAL_15_2_MAX),
    FieldSpec::new("quantity", FieldType::Number).max(DECIMAL_15_6_MAX),
    FieldSpec::new("price", FieldType::Number).max(DECIMAL_15_6_MAX),
    FieldSpec::new("date", FieldType::Date),
    FieldSpec::new("label.budget_id", FieldType::Uuid).nullable(),
    FieldSpec::new("label.category_id", FieldType::Uuid).nullable(),
];

async fn post_investment_transaction(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let body = match require_body_object(&ctx.req) {
        Ok(body) => body.clone(),
        Err(message) => return Ok(validation_error(message).into()),
    };

    let id = match require_string_field(&body, "investment_transaction_id") {
        Ok(id) => id,
        Err(message) => return Ok(validation_error(message).into()),
    };

    if let Err(message) = validate_fields(&body, INVESTMENT_TRANSACTION_BODY_SPEC) {
        return Ok(validation_error(message).into());
    }

    let response = update_investment_transactions(&user, std::slice::from_ref(&body)).await;
    let Some(result) = response.first().filter(|result| result.status < 400) else {
        let error = anyhow::anyhow!("Database responded with an error.");
        logger::error(
            "Failed to update investment transaction",
            Some(&crate::ctx! { "investmentTransactionId": id }),
            Some(&error),
        );
        return Err(error);
    };

    Ok(ApiResponse::success_with(json!({ "investment_transaction_id": result.id })).into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("POST", "/investment-transaction", post_investment_transaction)]
}
