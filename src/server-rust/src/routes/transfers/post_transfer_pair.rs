//! `POST /transfers/pair`: `src/server/routes/transfers/post-transfer-pair.ts`.

use serde_json::json;

use crate::js::{js_length, Json, Obj};
use crate::server::postgres::repositories::transfers::{confirm_transfer_pair, pair_transactions, ConfirmResult, PairResult};
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::{
    require_body_object, require_string_field, validate_fields, validation_error, FieldSpec, FieldType, Validation,
};

/// Typed fields on the body, checked at the boundary before any of them reach
/// SQL.
///
/// `pair_id` names the `transaction_pairs.pair_id` `UUID PRIMARY KEY` column:
/// a non-UUID value handed to `WHERE pair_id = $1` raises Postgres `22P02
/// invalid input syntax for type uuid` at the read, throwing out of the route:
/// a 500 plus an alarm for a body the route could have refused. The `uuid`
/// type refuses it here with the standard validation-error body instead.
const TRANSFER_PAIR_BODY_SPEC: [FieldSpec; 1] = [FieldSpec::new("pair_id", FieldType::Uuid)];

/// `transaction_pairs.transaction_id_a/b` are `VARCHAR(255) NOT NULL`.
const TRANSACTION_ID_MAX_LENGTH: usize = 255;

fn require_bounded_string_field(body: &Obj, field: &str) -> Validation<String> {
    let value = require_string_field(body, field)?;
    if js_length(&value) > TRANSACTION_ID_MAX_LENGTH {
        return Err(format!("Field {field} must be at most {TRANSACTION_ID_MAX_LENGTH} characters"));
    }
    Ok(value)
}

/// Confirms a suggested pair (`pair_id`), or pairs two transactions
/// (`transaction_id_a`, `transaction_id_b`, optionally `status: "confirmed"`).
async fn post_transfer_pair(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.user().cloned() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let body = match require_body_object(&ctx.req) {
        Ok(body) => body.clone(),
        Err(message) => return Ok(validation_error(message).into()),
    };

    if let Err(message) = validate_fields(&body, &TRANSFER_PAIR_BODY_SPEC) {
        return Ok(validation_error(message).into());
    }

    // With a pair_id, confirm an existing suggested pair.
    if let Some(Json::String(pair_id)) = body.get("pair_id") {
        return Ok(match confirm_transfer_pair(&user, pair_id).await? {
            ConfirmResult::Ok => ApiResponse::success_with(json!({ "pair_id": pair_id })),
            ConfirmResult::Failed { error } => ApiResponse::failed(error),
        }
        .into());
    }

    // Otherwise create a new pairing from two transaction ids.
    let a = match require_bounded_string_field(&body, "transaction_id_a") {
        Ok(a) => a,
        Err(message) => return Ok(validation_error(message).into()),
    };
    let b = match require_bounded_string_field(&body, "transaction_id_b") {
        Ok(b) => b,
        Err(message) => return Ok(validation_error(message).into()),
    };

    let status = if body.get("status") == Some(&json!("confirmed")) { "confirmed" } else { "suggested" };

    Ok(match pair_transactions(&user, &a, &b, Some(status)).await? {
        PairResult::Ok { pair_id } => ApiResponse::success_with(json!({ "pair_id": pair_id })),
        PairResult::Failed { error } => ApiResponse::failed(error),
    }
    .into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("POST", "/transfers/pair", post_transfer_pair)]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(value: Json) -> Obj {
        value.as_object().cloned().unwrap_or_default()
    }

    // `post-transfer-pair.test.ts`, the transaction id checks.
    #[test]
    fn a_transaction_id_is_a_string_of_at_most_255_utf16_code_units() {
        let field = "transaction_id_a";
        assert_eq!(require_bounded_string_field(&body(json!({})), field), Err("Missing required field: transaction_id_a".into()));
        assert_eq!(
            require_bounded_string_field(&body(json!({ field: null })), field),
            Err("Missing required field: transaction_id_a".into())
        );
        assert_eq!(require_bounded_string_field(&body(json!({ field: 5 })), field), Err("Field transaction_id_a must be a string".into()));
        let at_limit = "t".repeat(255);
        assert_eq!(require_bounded_string_field(&body(json!({ field: at_limit })), field), Ok(at_limit.clone()));
        let too_long = "Field transaction_id_a must be at most 255 characters".to_string();
        assert_eq!(require_bounded_string_field(&body(json!({ field: "t".repeat(256) })), field), Err(too_long.clone()));
        // A character outside the Basic Multilingual Plane counts twice, as in JavaScript.
        assert_eq!(require_bounded_string_field(&body(json!({ field: "😀".repeat(128) })), field), Err(too_long));
        let wide = format!("{}t", "😀".repeat(127));
        assert_eq!(require_bounded_string_field(&body(json!({ field: wide })), field), Ok(wide.clone()));
    }

    #[test]
    fn only_a_uuid_string_is_a_pair_id() {
        assert_eq!(validate_fields(&body(json!({})), &TRANSFER_PAIR_BODY_SPEC), Ok(()));
        for pair_id in [json!(null), json!(5), json!(""), json!("not-a-uuid")] {
            assert_eq!(
                validate_fields(&body(json!({ "pair_id": pair_id })), &TRANSFER_PAIR_BODY_SPEC),
                Err("Field pair_id must be a uuid".into())
            );
        }
        assert_eq!(
            validate_fields(&body(json!({ "pair_id": "3F2504E0-4F89-41D3-9A0C-0305E82C3301" })), &TRANSFER_PAIR_BODY_SPEC),
            Ok(())
        );
    }
}
