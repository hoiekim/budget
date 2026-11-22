//! `POST /split-transaction`: `src/server/routes/accounts/post-split-transaction.ts`.

use serde_json::json;

use crate::server::infer_label_confidence::infer_label_confidence;
use crate::server::logger;
use crate::server::postgres::repositories::split_transactions::update_split_transactions;
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::{
    require_body_object, require_string_field, validate_fields, validation_error, FieldSpec, FieldType, DECIMAL_15_2_MAX,
};

/// Typed fields `split_transaction::from_json` copies into a row
/// (`models/split_transaction.rs`). `split_transaction_id` is the table's
/// `UUID PRIMARY KEY`, so a non-UUID would reach the `WHERE` clause and
/// raise `22P02`. The `label.*` fields accept explicit null: that is how the
/// client clears a label.
const SPLIT_TRANSACTION_BODY_SPEC: &[FieldSpec] = &[
    FieldSpec::new("split_transaction_id", FieldType::Uuid),
    FieldSpec::new("transaction_id", FieldType::String).max_length(255),
    FieldSpec::new("amount", FieldType::Number).max(DECIMAL_15_2_MAX),
    FieldSpec::new("date", FieldType::Date),
    FieldSpec::new("label.budget_id", FieldType::Uuid).nullable(),
    FieldSpec::new("label.category_id", FieldType::Uuid).nullable(),
    FieldSpec::new("label.category_confidence", FieldType::Number).nullable(),
];

async fn post_split_transaction(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let body = match require_body_object(&ctx.req) {
        Ok(body) => body.clone(),
        Err(message) => return Ok(validation_error(message).into()),
    };

    let id = match require_string_field(&body, "split_transaction_id") {
        Ok(id) => id,
        Err(message) => return Ok(validation_error(message).into()),
    };

    if let Err(message) = validate_fields(&body, SPLIT_TRANSACTION_BODY_SPEC) {
        return Ok(validation_error(message).into());
    }

    let updated = async {
        let split = infer_label_confidence(&body)?;
        let response = update_split_transactions(&user, std::slice::from_ref(&split)).await;
        let Some(result) = response.first().filter(|result| result.status < 400) else {
            anyhow::bail!("Database responded with an error.");
        };
        anyhow::Ok(json!({ "split_transaction_id": result.id }))
    };

    match updated.await {
        Ok(body) => Ok(ApiResponse::success_with(body).into()),
        Err(error) => {
            logger::error("Failed to update split transaction", Some(&crate::ctx! { "splitTransactionId": id }), Some(&error));
            Err(error)
        }
    }
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("POST", "/split-transaction", post_split_transaction)]
}
