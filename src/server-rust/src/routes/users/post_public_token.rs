//! `POST /public-token`: `src/server/routes/users/post-public-token.ts`.

use serde_json::json;

use crate::common::date::get_date_string;
use crate::common::utils::get_random_id;
use crate::js::{Json, JsDate, Obj};
use crate::server::compute_tools::sync_plaid::{sync_plaid_accounts_of, sync_plaid_transactions_of};
use crate::server::compute_tools::sync_simple_fin::sync_simple_fin_data;
use crate::server::plaid::{exchange_public_token, get_item, is_plaid_configured};
use crate::server::postgres::models::MaskedUser;
use crate::server::postgres::repositories::items::{get_user_item, search_items, to_client_item, upsert_items, SearchItemsOptions};
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::simple_fin::exchange_setup_token;
use crate::server::validation::{require_query_string, validation_error};

const WRONG_TYPE_OF_PUBLIC_TOKEN: &str = "Request body has wrong type of public_token";

/// A field of `req.body ?? {}`: what destructuring reads, `undefined` for a
/// body that is not an object.
fn body_field<'a>(body: Option<&'a Json>, key: &str) -> Option<&'a Json> {
    body.and_then(|body| body.as_object()).and_then(|body| body.get(key))
}

fn as_obj(value: Json) -> Obj {
    match value {
        Json::Object(object) => object,
        _ => Obj::new(),
    }
}

/// Connects an item: a SimpleFin setup token or a Plaid public token is
/// exchanged for the item's credential, the item stored and synced; a manual
/// item is created once per user.
///
/// Query: `provider` (`simple_fin`, `plaid` or `manual`). Body:
/// `{ public_token }` for SimpleFin, `{ public_token, institution_id }` for Plaid.
async fn post_public_token(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let provider = match require_query_string(&ctx.req, "provider") {
        Ok(provider) => provider,
        Err(message) => return Ok(validation_error(message).into()),
    };

    // The body is absent when the request has no JSON content type, the JSON
    // does not parse, or it is a literal null: each reads as `{}`, so the
    // type checks below refuse it rather than failing the request.
    let body = ctx.req.body.as_ref();

    match provider.as_str() {
        "simple_fin" => {
            let Some(Json::String(public_token)) = body_field(body, "public_token") else {
                return Ok(ApiResponse::failed(WRONG_TYPE_OF_PUBLIC_TOKEN).into());
            };

            let item = exchange_simple_fin_token(public_token).await?;
            if item.get("access_token").and_then(Json::as_str) == Some("Forbidden") {
                return Ok(ApiResponse::failed("Invalid token").into());
            }

            upsert_items(&user, std::slice::from_ref(&item), None).await;
            let item_id = item.get("item_id").and_then(Json::as_str).unwrap_or_default().to_string();
            sync_simple_fin_data(&item_id).await?;

            Ok(ApiResponse::success_with(json!({ "item": to_client_item(&Json::Object(item)) })).into())
        }
        "plaid" => {
            let (Some(Json::String(public_token)), Some(Json::String(institution_id))) =
                (body_field(body, "public_token"), body_field(body, "institution_id"))
            else {
                return Ok(ApiResponse::failed(WRONG_TYPE_OF_PUBLIC_TOKEN).into());
            };

            if !is_plaid_configured() {
                return Ok(ApiResponse::failed("Plaid integration is not configured").into());
            }

            let item = exchange_plaid_token(&user, public_token, institution_id).await?;
            upsert_items(&user, std::slice::from_ref(&item), None).await;

            // Both syncs at once, each on the item as it was stored here,
            // whatever the other changes on it. In the TypeScript both reads
            // go out before either sync sends anything else, and both answer
            // before either sync has changed the item. Here the second read
            // can wait for a new database connection while the first sync
            // goes on, so the two reads are awaited together first. Which
            // sync then reaches Plaid first is left open, as there. Both run
            // to their end even when one fails, as the other goes on there
            // after the request has failed.
            let item_id = match item.get("item_id") {
                Some(Json::String(item_id)) => item_id.clone(),
                Some(other) => crate::js::to_js_string(other),
                None => "undefined".to_string(),
            };
            let (for_accounts, for_transactions) = futures::join!(get_user_item(&item_id), get_user_item(&item_id));
            let (accounts, transactions) = futures::join!(
                sync_plaid_accounts_of(&item_id, for_accounts),
                sync_plaid_transactions_of(&item_id, for_transactions)
            );
            accounts?;
            transactions?;

            Ok(ApiResponse::success_with(json!({ "item": to_client_item(&Json::Object(item)) })).into())
        }
        "manual" => {
            let items = search_items(&user, SearchItemsOptions { provider: Some("manual".to_string()), ..Default::default() }).await?;
            if items.iter().any(|e| e.get("user_id").and_then(Json::as_str) == Some(user.user_id.as_str())) {
                return Ok(ApiResponse::failed("Manual item already exists for the user").into());
            }
            let item = as_obj(json!({
                "item_id": get_random_id(),
                "access_token": "no_access_token",
                "provider": provider,
                "updated": get_date_string(JsDate::now()),
                "status": "ok",
                "institution_id": null,
                "available_products": [],
                "user_id": user.user_id,
            }));
            upsert_items(&user, std::slice::from_ref(&item), None).await;
            Ok(ApiResponse::success_with(json!({ "item": to_client_item(&Json::Object(item)) })).into())
        }
        _ => Ok(ApiResponse::failed("Request has wrong type of provider").into()),
    }
}

/// `[...list]` for a list Plaid may leave out (`= []`): its elements.
fn spread_products(value: Option<&Json>, name: &str) -> anyhow::Result<Vec<Json>> {
    match value {
        None => Ok(Vec::new()),
        Some(Json::Array(items)) => Ok(items.clone()),
        Some(Json::String(text)) => Ok(text.chars().map(|c| json!(c.to_string())).collect()),
        Some(Json::Null) => anyhow::bail!("null is not an object (evaluating '{name}')"),
        Some(_) => anyhow::bail!("Spread syntax requires ...iterable[Symbol.iterator] to be a function"),
    }
}

/// Exchanges the public token Link handed the browser for the item's access
/// token, and reads the item's products.
async fn exchange_plaid_token(user: &MaskedUser, public_token: &str, institution_id: &str) -> anyhow::Result<Obj> {
    let exchanged = exchange_public_token(user, public_token).await?;
    let access_token = exchanged.get("access_token").cloned();
    let item_id = exchanged.get("item_id").cloned();
    let access_token_text = match &access_token {
        Some(Json::String(token)) => token.clone(),
        Some(other) => crate::js::to_js_string(other),
        None => "undefined".to_string(),
    };
    let Some(plaid_item) = get_item(&access_token_text).await?.filter(|item| !item.is_null()) else {
        anyhow::bail!("Right side of assignment cannot be destructured");
    };
    let mut available_products = spread_products(plaid_item.get("consented_products"), "consented_products")?;
    available_products.extend(spread_products(plaid_item.get("products"), "products")?);

    let mut item = Obj::new();
    if let Some(item_id) = item_id {
        item.insert("item_id".into(), item_id);
    }
    if let Some(access_token) = access_token {
        item.insert("access_token".into(), access_token);
    }
    item.insert("institution_id".into(), json!(institution_id));
    item.insert("available_products".into(), Json::Array(available_products));
    item.insert("status".into(), json!("ok"));
    item.insert("provider".into(), json!("plaid"));
    Ok(item)
}

/// Claims the access URL a SimpleFin setup token points to; the item it
/// makes has a new id.
async fn exchange_simple_fin_token(setup_token: &str) -> anyhow::Result<Obj> {
    let access_url = exchange_setup_token(setup_token).await?;
    Ok(as_obj(json!({
        "item_id": uuid::Uuid::new_v4().to_string(),
        "access_token": access_url,
        "status": "ok",
        "provider": "simple_fin",
        "institution_id": null,
        "available_products": [],
    })))
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("POST", "/public-token", post_public_token)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_body_that_is_not_an_object_has_no_fields() {
        for body in [json!("token"), json!(42), json!(["token"]), json!(null), json!(true)] {
            assert_eq!(body_field(Some(&body), "public_token"), None, "{body}");
        }
        assert_eq!(body_field(None, "public_token"), None);
        assert_eq!(body_field(Some(&json!({ "public_token": 1 })), "public_token"), Some(&json!(1)));
    }

    #[test]
    fn products_plaid_leaves_out_are_none_and_a_list_is_spread() {
        assert_eq!(spread_products(None, "products").unwrap(), Vec::<Json>::new());
        assert_eq!(spread_products(Some(&json!(["transactions"])), "products").unwrap(), vec![json!("transactions")]);
        assert!(spread_products(Some(&json!(null)), "consented_products").is_err());
    }
}
