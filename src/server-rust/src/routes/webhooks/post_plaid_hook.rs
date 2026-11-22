//! `POST /plaid-hook`: `src/server/routes/webhooks/post-plaid-hook.ts`.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::json;

use crate::js::{Json, Obj};
use crate::server::compute_tools::sync_plaid::{sync_plaid_transactions, SyncTransactionsResult};
use crate::server::logger;
use crate::server::plaid::{get_item, is_plaid_configured, verify_webhook, WebhookVerification};
use crate::server::postgres::repositories::items::{get_user_item_of, update_item_status, upsert_items, UserItem};
use crate::server::rate_limit::PLAID_ITEM_KEY_FETCH_RATE_LIMITER;
use crate::server::realtime::spawn_emit_to_sharing_group;
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Reply, Route};
use crate::server::validation::{require_body_object, validation_error};

const VERIFICATION_FAILED: &str = "Webhook verification failed";

/// Handles a webhook from Plaid once its signature checks out: new
/// transactions or holdings are synced, an item that needs its user is marked
/// bad, and an item whose products changed has them read again.
async fn post_plaid_hook(ctx: &mut Ctx) -> HandlerResult {
    // Without Plaid credentials there is nothing legitimate to verify: refuse
    // before touching the Plaid API at all.
    if !is_plaid_configured() {
        logger::warn("[Plaid Webhook] Plaid not configured — rejecting webhook", None, None);
        ctx.status = 401;
        return Ok(ApiResponse::failed(VERIFICATION_FAILED).into());
    }

    // Verify the webhook's signature from Plaid.
    let signed_jwt = ctx.req.headers.get("plaid-verification").cloned();
    let Some(raw_body) = ctx.req.raw_body.clone().filter(|body| !body.is_empty()) else {
        logger::error("[Plaid Webhook] Raw body not available for verification", None, None);
        ctx.status = 401;
        return Ok(ApiResponse::failed(VERIFICATION_FAILED).into());
    };

    let mut verification = verify_webhook(&raw_body, signed_jwt.as_deref(), false).await;
    if verification == WebhookVerification::Unverifiable {
        if let Some(item_id) = claimed_real_item(ctx.req.body.as_ref()).await {
            if !PLAID_ITEM_KEY_FETCH_RATE_LIMITER.is_limited(&item_id) {
                PLAID_ITEM_KEY_FETCH_RATE_LIMITER.consume(&item_id, 1);
                verification = verify_webhook(&raw_body, signed_jwt.as_deref(), true).await;
            }
        }
    }
    if verification == WebhookVerification::Unverifiable {
        // Plaid retries a 5xx but treats a 401 as final, so a webhook that
        // couldn't be checked yet must not be refused as invalid.
        ctx.status = 503;
        return Ok(ApiResponse::failed("Webhook verification unavailable, retry later").into());
    }
    if verification == WebhookVerification::Invalid {
        ctx.status = 401;
        return Ok(ApiResponse::failed("Invalid webhook signature").into());
    }

    let body = match require_body_object(&ctx.req) {
        Ok(body) => body.clone(),
        Err(message) => return Ok(validation_error(message).into()),
    };

    let webhook_type = body.get("webhook_type");
    let webhook_code = body.get("webhook_code");
    let item_id = body.get("item_id");
    let code = webhook_code.and_then(Json::as_str);
    match webhook_type.and_then(Json::as_str) {
        Some("TRANSACTIONS") => {
            if code == Some("SYNC_UPDATES_AVAILABLE") {
                return Ok(sync_and_log(item_id).await?.into());
            } else if matches!(code, Some("DEFAULT_UPDATE" | "INITIAL_UPDATE" | "HISTORICAL_UPDATE" | "TRANSACTIONS_REMOVED")) {
                return Ok(ApiResponse::success().into());
            }
        }
        Some("ITEM") => match code {
            Some("WEBHOOK_UPDATE_ACKNOWLEDGED") => return Ok(ApiResponse::success().into()),
            Some("PENDING_EXPIRATION") => return Ok(mark_bad_item(item_id, "PENDING_EXPIRATION").await?.into()),
            Some("ERROR") => {
                let error_code = body.get("error").and_then(|error| error.get("error_code"));
                if error_code.and_then(Json::as_str) == Some("ITEM_LOGIN_REQUIRED") {
                    return Ok(mark_bad_item(item_id, "ITEM_LOGIN_REQUIRED").await?.into());
                }
            }
            Some("USER_ACCOUNT_REVOKED" | "ITEM_UPDATED") => return Ok(refresh_item_products(item_id).await?.into()),
            _ => {}
        },
        Some("HOLDINGS") => {
            if code == Some("DEFAULT_UPDATE") {
                return Ok(sync_and_log(item_id).await?.into());
            }
        }
        Some("INVESTMENTS_TRANSACTIONS") => {
            if matches!(code, Some("DEFAULT_UPDATE" | "HISTORICAL_UPDATE")) {
                return Ok(sync_and_log(item_id).await?.into());
            }
        }
        _ => {}
    }

    let mut context = Obj::new();
    for (key, value) in [("itemId", item_id), ("webhookType", webhook_type), ("webhookCode", webhook_code), ("body", ctx.req.body.as_ref())]
    {
        if let Some(value) = value {
            context.insert(key.into(), value.clone());
        }
    }
    logger::warn("Unhandled webhook", Some(&context), None);
    Ok(Reply::None)
}

/// `{ status: "failed" }`, without a message.
fn failed() -> ApiResponse {
    ApiResponse { status: "failed", body: None, message: None }
}

/// The user and item a webhook's `item_id` names. Any value but text is
/// looked up as it is, failing in the database where the TypeScript does.
async fn user_item_of(item_id: Option<&Json>) -> anyhow::Result<Option<UserItem>> {
    get_user_item_of(item_id.unwrap_or(&Json::Null)).await
}

async fn sync_and_log(item_id: Option<&Json>) -> anyhow::Result<ApiResponse> {
    let response: Option<SyncTransactionsResult> = match item_id {
        Some(Json::String(item_id)) => sync_plaid_transactions(item_id).await?,
        other => {
            // An id that is not text names no item, unless looking it up fails.
            user_item_of(other).await?;
            None
        }
    };
    let Some(SyncTransactionsResult { user_id, added, modified, removed }) = response else { return Ok(failed()) };
    let mut context = Obj::new();
    if let Some(item_id) = item_id {
        context.insert("itemId".into(), item_id.clone());
    }
    context.insert("added".into(), json!(added));
    context.insert("modified".into(), json!(modified));
    context.insert("removed".into(), json!(removed));
    logger::info("Synced transactions via webhook", Some(&context));
    if added != 0 || modified != 0 || removed != 0 {
        // The sync writes both transactions and investment transactions, but
        // only `transactions` is emitted: the client fetches both series in
        // one /api/transactions request for it, so emitting
        // `investment_transactions` too would make it fetch twice.
        spawn_emit_to_sharing_group(&user_id, "transactions", None);
    }
    Ok(ApiResponse::success())
}

/// `{ consented_products = [], products = [] }` spread into one list.
fn products_of(plaid_item: &Json) -> anyhow::Result<Vec<Json>> {
    let mut products = Vec::new();
    for key in ["consented_products", "products"] {
        match plaid_item.get(key) {
            None => {}
            Some(Json::Array(items)) => products.extend(items.iter().cloned()),
            Some(Json::String(text)) => products.extend(text.chars().map(|c| json!(c.to_string()))),
            Some(Json::Null) => anyhow::bail!("null is not an object (evaluating '{key}')"),
            Some(_) => anyhow::bail!("Spread syntax requires ...iterable[Symbol.iterator] to be a function"),
        }
    }
    Ok(products)
}

async fn refresh_item_products(item_id: Option<&Json>) -> anyhow::Result<ApiResponse> {
    let Some(UserItem { user, item }) = user_item_of(item_id).await? else { return Ok(failed()) };
    let access_token = match item.get("access_token") {
        Some(Json::String(token)) => token.clone(),
        Some(other) => crate::js::to_js_string(other),
        None => "undefined".to_string(),
    };
    let Some(plaid_item) = get_item(&access_token).await?.filter(|item| !item.is_null()) else {
        anyhow::bail!("Right side of assignment cannot be destructured");
    };
    let available_products = Json::Array(products_of(&plaid_item)?);
    let mut updated = item.as_object().cloned().unwrap_or_default();
    updated.insert("available_products".into(), available_products.clone());
    upsert_items(&user, &[updated], None).await;
    let mut context = Obj::new();
    if let Some(item_id) = item_id {
        context.insert("itemId".into(), item_id.clone());
    }
    context.insert("available_products".into(), available_products);
    logger::info("Refreshed available_products for item", Some(&context));
    spawn_emit_to_sharing_group(&user.user_id, "accounts", None);
    Ok(ApiResponse::success())
}

/// Marks the item bad. The `item_id` arrives in the webhook body, so the
/// status write is scoped to the owner resolved from it rather than keyed on
/// the id alone. The same lookup addresses the change event: a webhook lands
/// out of band from any user's tab, so this write does not ride the
/// per-request event of the HTTP layer.
async fn mark_bad_item(item_id: Option<&Json>, reason: &str) -> anyhow::Result<ApiResponse> {
    let Some(UserItem { user, .. }) = user_item_of(item_id).await? else {
        let mut context = Obj::new();
        if let Some(item_id) = item_id {
            context.insert("itemId".into(), item_id.clone());
        }
        logger::warn("Plaid webhook status update skipped — no user for item", Some(&context), None);
        return Ok(failed());
    };
    let item_id = item_id.and_then(Json::as_str).unwrap_or_default();
    let updated = update_item_status(&user, item_id, "bad", Some(reason)).await?;
    if !updated {
        return Ok(failed());
    }
    spawn_emit_to_sharing_group(&user.user_id, "accounts", None);
    Ok(ApiResponse::success())
}

/// Item ids as Plaid, SimpleFin and manual items write them.
static ITEM_ID_SHAPE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,100}$").unwrap());

/// The item id an unverified body claims, when that item exists. Read only to
/// decide whether a key fetch may pass the process-wide cap, never trusted as
/// the webhook's content, which is read again after verification. An id that
/// isn't item-shaped never reaches the database, and a lookup that fails
/// counts as no item.
async fn claimed_real_item(body: Option<&Json>) -> Option<String> {
    let Some(Json::String(item_id)) = body.and_then(|body| body.get("item_id")) else { return None };
    if !ITEM_ID_SHAPE.is_match(item_id) {
        return None;
    }
    match get_user_item_of(&json!(item_id)).await {
        Ok(found) => found.map(|_| item_id.clone()),
        Err(error) => {
            logger::warn("[Plaid Webhook] Item lookup for key priority failed", None, Some(&error));
            None
        }
    }
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("POST", "/plaid-hook", post_plaid_hook)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn item_shaped_ids_are_one_to_a_hundred_letters_digits_underscores_or_dashes() {
        for id in ["M5eVJqLnv3tbzdngLDp9FL5OlDNxlNhlE55op", "item-1", "a_b", &"x".repeat(100)] {
            assert!(ITEM_ID_SHAPE.is_match(id), "{id}");
        }
        for id in ["", "a b", "a\u{0}b", "a/b", "é", &"x".repeat(101), "item-1\n"] {
            assert!(!ITEM_ID_SHAPE.is_match(id), "{id:?}");
        }
    }

    #[tokio::test]
    async fn only_a_body_naming_an_item_shaped_text_id_is_looked_up() {
        for body in [json!("item-1"), json!([1]), json!({}), json!({ "item_id": 42 }), json!({ "item_id": "a b" })] {
            assert_eq!(claimed_real_item(Some(&body)).await, None, "{body}");
        }
        assert_eq!(claimed_real_item(None).await, None);
    }

    #[test]
    fn the_products_are_the_consented_ones_then_the_billed_ones() {
        assert_eq!(products_of(&json!({})).unwrap(), Vec::<Json>::new());
        assert_eq!(
            products_of(&json!({ "consented_products": ["auth"], "products": ["transactions", "investments"] })).unwrap(),
            vec![json!("auth"), json!("transactions"), json!("investments")]
        );
        assert_eq!(products_of(&json!({ "products": null })).unwrap_err().to_string(), "null is not an object (evaluating 'products')");
    }

    #[test]
    fn a_failure_carries_no_message() {
        assert_eq!(failed().to_json(), json!({ "status": "failed" }));
    }
}
