//! Accounts and holdings of Plaid items: `src/server/lib/plaid/accounts.ts`.

use std::sync::Mutex;

use serde_json::json;

use super::util::{error_code_of, get_client, is_ignorable_error_code, is_item_error, logged_value, plaid_error_of};
use crate::js::{number_to_string, truthy, Json, Obj};
use crate::server::logger;
use crate::server::postgres::models::MaskedUser;
use crate::server::postgres::repositories::items::{update_item_status, upsert_items};

/// The Plaid product an item must have for its holdings to be fetched.
pub const INVESTMENTS: &str = "investments";

/// What `get_accounts` gathers: each item as it went (carrying `plaidError`
/// when its fetch failed) and every account fetched.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PlaidAccountsResponse {
    pub items: Vec<Json>,
    pub accounts: Vec<Json>,
}

/// What `get_holdings` gathers.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PlaidHoldingsResponse {
    pub items: Vec<Json>,
    pub accounts: Vec<Json>,
    pub holdings: Vec<Json>,
    pub securities: Vec<Json>,
}

/// `{ ...item }`, with `plaidError` set when there is one.
pub(super) fn item_with_error(item: &Json, plaid_error: Option<&Json>) -> Json {
    let mut copy = item.as_object().cloned().unwrap_or_default();
    if let Some(plaid_error) = plaid_error {
        copy.insert("plaidError".into(), plaid_error.clone());
    }
    Json::Object(copy)
}

/// `String(value)` of a field as a template literal writes it; `undefined` when absent.
pub(super) fn template_string(value: Option<&Json>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(Json::String(text)) => text.clone(),
        Some(Json::Number(n)) => number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Some(Json::Null) => "null".to_string(),
        Some(Json::Bool(b)) => b.to_string(),
        Some(Json::Array(_)) | Some(Json::Object(_)) => crate::js::to_js_string(value.unwrap_or(&Json::Null)),
    }
}

/// `response.data.<key>`: reading a member of `null` throws, as in JavaScript.
pub(super) fn member<'a>(data: &'a Json, key: &str) -> anyhow::Result<Option<&'a Json>> {
    match data {
        Json::Null => anyhow::bail!("null is not an object (evaluating 'response.data.{key}')"),
        Json::Object(map) => Ok(map.get(key)),
        _ => Ok(None),
    }
}

/// Appends a list the way `[...].flat()` spreads it: an array's elements, or the value itself.
pub(super) fn extend_flat(into: &mut Vec<Json>, value: Option<&Json>) {
    match value {
        None => {}
        Some(Json::Array(items)) => into.extend(items.iter().cloned()),
        Some(other) => into.push(other.clone()),
    }
}

/// `item.available_products.includes(Products.Investments)`; reading it from a
/// missing list throws.
pub(super) fn has_investments(item: &Json) -> anyhow::Result<bool> {
    match item.get("available_products") {
        Some(Json::Array(products)) => Ok(products.iter().any(|product| product.as_str() == Some(INVESTMENTS))),
        Some(Json::String(text)) => Ok(text.contains(INVESTMENTS)),
        _ => anyhow::bail!("undefined is not an object (evaluating 'item.available_products.includes')"),
    }
}

/// The status reason `updateItemStatus` stores for an error code.
pub(super) fn status_reason_of(error_code: Option<&Json>) -> Option<String> {
    match error_code {
        Some(Json::String(code)) => Some(code.clone()),
        Some(Json::Number(n)) => Some(number_to_string(n.as_f64().unwrap_or(f64::NAN))),
        _ => None,
    }
}

/// Marks the item `bad` with the error code as its reason, in the background;
/// a failure is logged.
fn mark_item_bad(user: &MaskedUser, item_id: &str, plaid_error: &Json) {
    let (user, item_id) = (user.clone(), item_id.to_string());
    let reason = status_reason_of(plaid_error.get("error_code"));
    tokio::spawn(async move {
        if let Err(error) = update_item_status(&user, &item_id, "bad", reason.as_deref()).await {
            logger::error("Failed to update item status to BAD", Some(&crate::ctx! { "itemId": item_id }), Some(&error));
        }
    });
}

fn item_id_of(item: &Json) -> Json {
    item.get("item_id").cloned().unwrap_or(Json::Null)
}

/// Fetches the accounts of each item, all at once. An item whose fetch fails
/// comes back carrying the error (`plaidError`), and is marked `bad` when it
/// was an item error.
pub async fn get_accounts(user: &MaskedUser, items: &[Json]) -> anyhow::Result<PlaidAccountsResponse> {
    let client = get_client(Some(user))?;

    // Pushed as each fetch settles, as the TypeScript's jobs push.
    let data = Mutex::new(PlaidAccountsResponse::default());
    let all_accounts: Mutex<Vec<Json>> = Mutex::new(Vec::new());

    let fetch_jobs = items.iter().map(|item| {
        let (client, data, all_accounts) = (&client, &data, &all_accounts);
        async move {
            let item_id = item_id_of(item);
            let mut request = Obj::new();
            if let Some(access_token) = item.get("access_token") {
                request.insert("access_token".into(), access_token.clone());
            }
            let fetched = async {
                let response = client.call("/accounts/get", &Json::Object(request)).await?;
                let accounts = member(&response, "accounts")?.cloned();
                anyhow::Ok(accounts)
            };
            match fetched.await {
                Ok(accounts) => {
                    extend_flat(&mut all_accounts.lock().unwrap(), accounts.as_ref());
                    data.lock().unwrap().items.push(item_with_error(item, None));
                }
                Err(error) => {
                    let plaid_error = plaid_error_of(&error).cloned();
                    if error_code_of(plaid_error.as_ref()) == Some("ITEM_LOGIN_REQUIRED") {
                        logger::warn(
                            "Failed to get accounts data: ITEM_LOGIN_REQUIRED",
                            Some(&crate::ctx! { "itemId": item_id }),
                            None,
                        );
                    } else {
                        let logged = match plaid_error.as_ref().filter(|data| truthy(data)) {
                            Some(data) => logged_value(data),
                            None => error,
                        };
                        logger::error("Failed to get accounts data", Some(&crate::ctx! { "itemId": item_id }), Some(&logged));
                    }
                    if let Some(plaid_error) = plaid_error.as_ref().filter(|data| is_item_error(Some(data))) {
                        mark_item_bad(user, item_id.as_str().unwrap_or_default(), plaid_error);
                    }
                    data.lock().unwrap().items.push(item_with_error(item, plaid_error.as_ref()));
                }
            }
        }
    });
    futures::future::join_all(fetch_jobs).await;

    let mut data = data.into_inner().unwrap();
    data.accounts = all_accounts.into_inner().unwrap();
    Ok(data)
}

/// Fetches the holdings, with their accounts and securities, of each item that
/// has the Investments product, all at once. An item Plaid says does not
/// support holdings loses the product; any other failure but an ignorable one
/// comes back carrying the error, and marks the item `bad` when it was an item
/// error.
pub async fn get_holdings(user: &MaskedUser, items: &[Json]) -> anyhow::Result<PlaidHoldingsResponse> {
    let client = get_client(Some(user))?;

    let data = Mutex::new(PlaidHoldingsResponse::default());
    let all_accounts: Mutex<Vec<Json>> = Mutex::new(Vec::new());
    let all_holdings: Mutex<Vec<Json>> = Mutex::new(Vec::new());
    let all_securities: Mutex<Vec<Json>> = Mutex::new(Vec::new());

    let fetch_jobs = items.iter().map(|item| {
        let (client, data) = (&client, &data);
        let (all_accounts, all_holdings, all_securities) = (&all_accounts, &all_holdings, &all_securities);
        async move {
            let item_id = item_id_of(item);
            if !has_investments(item)? {
                return anyhow::Ok(());
            }
            let mut request = Obj::new();
            if let Some(access_token) = item.get("access_token") {
                request.insert("access_token".into(), access_token.clone());
            }
            let fetched = async {
                let response = client.call("/investments/holdings/get", &Json::Object(request)).await?;
                let accounts = member(&response, "accounts")?.cloned();
                let holdings = response.get("holdings").cloned();
                let securities = response.get("securities").cloned();

                extend_flat(&mut all_accounts.lock().unwrap(), accounts.as_ref());

                let Some(Json::Array(holdings)) = holdings else {
                    anyhow::bail!("undefined is not an object (evaluating 'holdings.map')");
                };
                let filled: Vec<Json> = holdings
                    .iter()
                    .map(|holding| {
                        let holding_id =
                            format!("{}_{}", template_string(holding.get("account_id")), template_string(holding.get("security_id")));
                        let mut filled = holding.as_object().cloned().unwrap_or_default();
                        filled.insert("holding_id".into(), json!(holding_id));
                        Json::Object(filled)
                    })
                    .collect();

                all_holdings.lock().unwrap().extend(filled);
                extend_flat(&mut all_securities.lock().unwrap(), securities.as_ref());
                anyhow::Ok(())
            };
            match fetched.await {
                Ok(()) => data.lock().unwrap().items.push(item_with_error(item, None)),
                Err(error) => {
                    let plaid_error = plaid_error_of(&error).cloned();
                    let error_code = plaid_error.as_ref().and_then(|data| data.get("error_code")).cloned();
                    let code_text = error_code.as_ref().and_then(Json::as_str);
                    if code_text == Some("PRODUCTS_NOT_SUPPORTED") {
                        logger::info(
                            "Holdings not supported for item, removing Investments from available_products",
                            Some(&crate::ctx! { "itemId": item_id }),
                        );
                        let updated_products: Vec<Json> = match item.get("available_products") {
                            Some(Json::Array(products)) => {
                                products.iter().filter(|product| product.as_str() != Some(INVESTMENTS)).cloned().collect()
                            }
                            _ => Vec::new(),
                        };
                        let mut updated = item.as_object().cloned().unwrap_or_default();
                        updated.insert("available_products".into(), Json::Array(updated_products));
                        let user = user.clone();
                        // `upsert_items` reports a failed write per item and never fails itself.
                        tokio::spawn(async move {
                            upsert_items(&user, &[updated], None).await;
                        });
                    } else if !error_code.as_ref().is_some_and(truthy) || !code_text.is_some_and(is_ignorable_error_code) {
                        let logged = match plaid_error.as_ref().filter(|data| truthy(data)) {
                            Some(data) => logged_value(data),
                            None => error,
                        };
                        logger::error("Failed to get holdings data", Some(&crate::ctx! { "itemId": item_id }), Some(&logged));
                        if let Some(plaid_error) = plaid_error.as_ref().filter(|data| is_item_error(Some(data))) {
                            mark_item_bad(user, item_id.as_str().unwrap_or_default(), plaid_error);
                        }
                        data.lock().unwrap().items.push(item_with_error(item, plaid_error.as_ref()));
                    }
                }
            }
            anyhow::Ok(())
        }
    });
    for result in futures::future::join_all(fetch_jobs).await {
        result?;
    }

    let mut data = data.into_inner().unwrap();
    data.accounts = all_accounts.into_inner().unwrap();
    data.holdings = all_holdings.into_inner().unwrap();
    data.securities = all_securities.into_inner().unwrap();
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_item_carries_its_error_only_when_there_is_one() {
        let item = json!({ "item_id": "i-1", "access_token": "a" });
        assert_eq!(item_with_error(&item, None), item);
        assert_eq!(
            item_with_error(&item, Some(&json!({ "error_code": "X" }))),
            json!({ "item_id": "i-1", "access_token": "a", "plaidError": { "error_code": "X" } })
        );
    }

    #[test]
    fn a_holding_id_joins_the_account_and_the_security_as_a_template_literal_does() {
        assert_eq!(format!("{}_{}", template_string(Some(&json!("acc"))), template_string(Some(&json!("sec")))), "acc_sec");
        assert_eq!(template_string(None), "undefined");
        assert_eq!(template_string(Some(&json!(null))), "null");
        assert_eq!(template_string(Some(&json!(12.5))), "12.5");
    }

    #[test]
    fn the_investments_product_is_read_from_the_item() {
        assert!(has_investments(&json!({ "available_products": ["transactions", "investments"] })).unwrap());
        assert!(!has_investments(&json!({ "available_products": ["transactions"] })).unwrap());
        assert!(has_investments(&json!({ "available_products": null })).is_err());
    }

    #[test]
    fn reading_a_member_of_null_fails_and_of_text_is_undefined() {
        assert!(member(&json!(null), "accounts").is_err());
        assert_eq!(member(&json!("text"), "accounts").unwrap(), None);
        assert_eq!(member(&json!({ "accounts": [] }), "accounts").unwrap(), Some(&json!([])));
    }
}
