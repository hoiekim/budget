//! `POST /validate-ticker`: `src/server/routes/accounts/post-validate-ticker.ts`.

use serde_json::json;

use crate::common::date::get_date_time_string_of;
use crate::common::utils::get_random_id;
use crate::js::{self, JsDate, Json, Obj};
use crate::server::market_data::{get_close_price_with_fallback, get_ticker_detail_with_fallback};
use crate::server::polygon::{self, LookupOptions, PolygonErrorKind};
use crate::server::postgres::repositories::securities::{search_securities, upsert_securities, SearchSecuritiesOptions};
use crate::server::rate_limit::{POLYGON_LOOKUP_RATE_LIMITER, POLYGON_LOOKUP_SHED_MESSAGE};
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::{require_body_object, require_ticker_symbol, validation_error};

/// `currency_name.toUpperCase()` on what the upstream sent, failing where the TypeScript throws.
fn upper_case_currency(currency_name: &Option<Json>) -> anyhow::Result<String> {
    match currency_name {
        Some(Json::String(currency_name)) => Ok(currency_name.to_uppercase()),
        None => anyhow::bail!("undefined is not an object (evaluating 'currency_name.toUpperCase')"),
        Some(Json::Null) => anyhow::bail!("null is not an object (evaluating 'currency_name.toUpperCase')"),
        Some(_) => anyhow::bail!(
            "currency_name.toUpperCase is not a function. (In 'currency_name.toUpperCase()', 'currency_name.toUpperCase' is undefined)"
        ),
    }
}

/// Validates a ticker symbol against the market data (Polygon, falling back
/// to Yahoo) and, unless `save` is `false`, stores the security it names.
///
/// Body: `{ ticker_symbol: string, save?: boolean }`.
async fn post_validate_ticker(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let body = match require_body_object(&ctx.req) {
        Ok(body) => body.clone(),
        Err(message) => return Ok(validation_error(message).into()),
    };
    let upper_ticker = match require_ticker_symbol(&body, "ticker_symbol") {
        Ok(upper_ticker) => upper_ticker,
        Err(message) => return Ok(validation_error(message).into()),
    };

    // A security already stored answers without a lookup.
    let existing = search_securities(SearchSecuritiesOptions { ticker_symbol: Some(upper_ticker.clone()), ..Default::default() }).await?;
    if let Some(security) = existing.into_iter().next() {
        return Ok(ApiResponse::success_with(json!({ "valid": true, "security": security })).into());
    }

    // Only lookups that get past the local short-circuit can reach Polygon's
    // process-wide rate gate, which the price-refresh passes and every other
    // signed-in caller share. Those are the ones a single caller is capped on.
    if POLYGON_LOOKUP_RATE_LIMITER.is_limited(&user.user_id) {
        return Ok(ApiResponse::failed(POLYGON_LOOKUP_SHED_MESSAGE).into());
    }
    POLYGON_LOOKUP_RATE_LIMITER.consume(&user.user_id, 1);

    // Validate against Polygon, falling back to Yahoo for symbols Polygon
    // does not carry (mutual funds, chiefly). The TypeScript starts both
    // lookups at once and the detail's requests always go out first; asking
    // one after the other keeps that order at each upstream, where two
    // concurrent requests here would race. The price is asked for even when
    // the detail lookup failed, as it is there.
    let options = LookupOptions { max_wait_ms: Some(polygon::FOREGROUND_QUEUE_WAIT_MS), ..Default::default() };
    let detail_result = get_ticker_detail_with_fallback(&upper_ticker, &options).await;
    let price_result = get_close_price_with_fallback(&upper_ticker, JsDate::now(), &options).await;
    let (detail_result, price_result) = (detail_result?, price_result?);

    let detail = match detail_result {
        Ok(detail) => detail,
        // Only an empty answer from Polygon is a verdict on the symbol. A shed
        // lookup, an unconfigured key, a plan that does not carry the data
        // and an upstream refusal say nothing about it, so none of them may
        // come back as `valid: false`: the form would label a good ticker invalid.
        Err(failure) if failure.error != PolygonErrorKind::NoData => {
            let message = if failure.error == PolygonErrorKind::NoApiKey {
                "Market data API is not configured. Contact your administrator.".to_string()
            } else {
                failure.message
            };
            return Ok(ApiResponse::failed(message).into());
        }
        Err(_) => {
            let message = format!("Ticker \"{upper_ticker}\" not found or invalid.");
            return Ok(ApiResponse::success_with(json!({ "valid": false, "message": message })).into());
        }
    };

    let close_price = price_result.ok();
    let mut security = Obj::new();
    security.insert("security_id".into(), json!(get_random_id()));
    security.insert("ticker_symbol".into(), json!(upper_ticker));
    if let Some(name) = &detail.name {
        security.insert("name".into(), name.clone());
    }
    security.insert("iso_currency_code".into(), json!(upper_case_currency(&detail.currency_name)?));
    security.insert("close_price".into(), close_price.map(js::num).unwrap_or(Json::Null));
    security.insert("close_price_as_of".into(), close_price.map(|_| json!(get_date_time_string_of(JsDate::now()))).unwrap_or(Json::Null));
    for key in [
        "isin",
        "cusip",
        "sedol",
        "institution_security_id",
        "institution_id",
        "proxy_security_id",
        "is_cash_equivalent",
        "type",
        "update_datetime",
        "unofficial_currency_code",
        "market_identifier_code",
        "sector",
        "industry",
        "option_contract",
        "fixed_income",
    ] {
        security.insert(key.into(), Json::Null);
    }

    // `save` defaults to true. A failed write is logged by `upsert_securities`
    // and is not fatal: the answer is still the valid security.
    if body.get("save") != Some(&Json::Bool(false)) {
        upsert_securities(std::slice::from_ref(&security)).await;
    }

    Ok(ApiResponse::success_with(json!({ "valid": true, "security": security })).into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("POST", "/validate-ticker", post_validate_ticker)]
}
