//! `POST /api-keys`: `src/server/routes/api-keys/post-api-keys.ts`.

use serde_json::json;

use crate::js::{js_length, truthy, Json, JsDate};
use crate::server::logger;
use crate::server::postgres::repositories::api_keys::create_api_key;
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::js_trim;

const ALLOWED_SCOPES: [&str; 1] = ["transactions:suggest"];

/// Issues a key to the caller. The full plaintext is in this response and
/// nowhere else: only its hash is stored.
async fn post_api_keys(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.user().cloned() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };
    let failed = |message: &str| Ok(ApiResponse::failed(message).into());

    let Some(body) = ctx.req.body.as_ref().filter(|body| truthy(body)) else {
        return failed("Body must be JSON.");
    };
    // Anything but an object has none of the fields.
    let field = |name: &str| body.as_object().and_then(|body| body.get(name));

    let Some(name) = field("name").and_then(Json::as_str).filter(|name| !js_trim(name).is_empty()) else {
        return failed("name is required and must be a non-empty string.");
    };
    if js_length(name) > 255 {
        return failed("name must be 255 characters or fewer.");
    }
    let scopes: Option<Vec<String>> = field("scopes")
        .and_then(Json::as_array)
        .and_then(|scopes| scopes.iter().map(|scope| scope.as_str().map(str::to_string)).collect());
    let Some(scopes) = scopes.filter(|scopes| !scopes.is_empty()) else {
        return failed("scopes must be a non-empty string array.");
    };
    if let Some(unknown) = scopes.iter().find(|scope| !ALLOWED_SCOPES.contains(&scope.as_str())) {
        return failed(&format!("Unknown scope: {unknown}"));
    }
    let expires_at = match field("expires_at") {
        None | Some(Json::Null) => None,
        Some(Json::String(text)) => {
            let ts = JsDate::parse(text).get_time();
            if ts.is_nan() {
                return failed("expires_at is not a valid ISO timestamp.");
            }
            if ts <= JsDate::now_ms() {
                return failed("expires_at must be in the future.");
            }
            Some(JsDate::from_ms(ts))
        }
        Some(_) => return failed("expires_at must be an ISO timestamp string."),
    };

    let created = async {
        let expires_at = match expires_at {
            // A date too far off to print is one the database refuses as well.
            Some(date) => Some(date.to_iso_string().ok_or_else(|| anyhow::anyhow!("timestamp out of range"))?),
            None => None,
        };
        create_api_key(&user.user_id, js_trim(name), &scopes, expires_at.as_deref()).await
    };
    match created.await {
        Ok(created) => Ok(ApiResponse::success_with(json!({
            "key_id": created.key_id,
            "prefix": created.prefix,
            "plaintext": created.plaintext,
        }))
        .into()),
        Err(error) => {
            logger::error("Failed to create API key", Some(&crate::ctx! { "userId": user.user_id }), Some(&error));
            Err(error)
        }
    }
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("POST", "/api-keys", post_api_keys)]
}
