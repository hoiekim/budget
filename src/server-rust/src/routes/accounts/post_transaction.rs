//! `POST /transaction`: `src/server/routes/accounts/post-transaction.ts`.

use serde_json::json;

use crate::js::Json;
use crate::server::infer_label_confidence::infer_label_confidence;
use crate::server::logger;
use crate::server::postgres::repositories::transactions::update_transactions;
use crate::server::record_category_rejection::{get_prev_label, record_category_rejection};
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::{
    require_body_object, require_string_field, validate_fields, validation_error, FieldSpec, FieldType, DECIMAL_15_2_MAX,
};

/// Typed fields `transaction::from_json` copies into a row
/// (`models/transaction.rs`). `amount` and `date` are not nullable: `date` is
/// a `DATE NOT NULL` column and the client's `JSONTransaction.amount` is a
/// plain number that downstream arithmetic reads unguarded. The `label.*`
/// fields accept explicit null: that is how the client clears a label.
const TRANSACTION_BODY_SPEC: &[FieldSpec] = &[
    FieldSpec::new("amount", FieldType::Number).max(DECIMAL_15_2_MAX),
    FieldSpec::new("date", FieldType::Date),
    FieldSpec::new("pending", FieldType::Boolean).nullable(),
    FieldSpec::new("label.budget_id", FieldType::Uuid).nullable(),
    FieldSpec::new("label.category_id", FieldType::Uuid).nullable(),
    FieldSpec::new("label.category_confidence", FieldType::Number).nullable(),
];

async fn post_transaction(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let body = match require_body_object(&ctx.req) {
        Ok(body) => body.clone(),
        Err(message) => return Ok(validation_error(message).into()),
    };

    let tx_id = match require_string_field(&body, "transaction_id") {
        Ok(id) => id,
        Err(message) => return Ok(validation_error(message).into()),
    };

    if let Err(message) = validate_fields(&body, TRANSACTION_BODY_SPEC) {
        return Ok(validation_error(message).into());
    }

    let updated = async {
        let transaction = infer_label_confidence(&body)?;

        // Read the previous label BEFORE the update. The update overwrites
        // the columns this needs to see (category_id, budget_id,
        // category_confidence), so reading in parallel would race against
        // the write and the mirror could mis-classify the rejection.
        let req_label = transaction.get("label").cloned();
        let will_touch_category = match &req_label {
            Some(Json::Object(label)) => label.contains_key("category_id"),
            _ => false,
        };
        let prev_label = if will_touch_category && !tx_id.is_empty() { Some(get_prev_label(&user, &tx_id).await?) } else { None };

        let response = update_transactions(&user, std::slice::from_ref(&transaction)).await?;
        let result = response.first();
        if result.is_some_and(|result| result.status == 422) {
            return Ok(ApiResponse::failed("Failed to update transaction."));
        }
        let Some(result) = result.filter(|result| result.status < 400) else {
            anyhow::bail!("Database responded with an error.");
        };
        let transaction_id = result.id.clone();

        // The rejected_categories mirror runs off the latency path: the
        // answer doesn't depend on whether it succeeds.
        if let (true, Some(prev_label), false) = (will_touch_category, prev_label, transaction_id.is_empty()) {
            let user = user.clone();
            let mirrored_id = transaction_id.clone();
            tokio::spawn(async move {
                if let Err(error) = record_category_rejection(&user, &mirrored_id, req_label.as_ref(), &prev_label).await {
                    logger::warn(
                        "Failed to mirror category change into rejected_categories",
                        Some(&crate::ctx! { "transactionId": mirrored_id }),
                        Some(&error),
                    );
                }
            });
        }

        anyhow::Ok(ApiResponse::success_with(json!({ "transaction_id": transaction_id })))
    };

    match updated.await {
        Ok(response) => Ok(response.into()),
        Err(error) => {
            logger::error("Failed to update transaction", Some(&crate::ctx! { "transactionId": tx_id }), Some(&error));
            Err(error)
        }
    }
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("POST", "/transaction", post_transaction)]
}
