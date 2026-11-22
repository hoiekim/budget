//! Link tokens, public-token exchange and items: `src/server/lib/plaid/tokens.ts`.

use serde_json::json;

use super::util::{get_client, PlaidClient};
use crate::js::{Json, Obj};
use crate::server::postgres::models::MaskedUser;

fn host_name() -> String {
    std::env::var("HOST_NAME").unwrap_or_else(|_| "undefined".to_string())
}

/// The `/link/token/create` request: a new link for the Transactions product,
/// or, with an access token, update mode for that item with account selection.
pub fn link_token_request(user: &MaskedUser, access_token: Option<&str>) -> Json {
    let host_name = host_name();
    let mut request = Obj::new();
    request.insert("user".into(), json!({ "client_user_id": user.user_id }));
    request.insert("client_name".into(), json!("Budget App"));
    request.insert("country_codes".into(), json!(["US"]));
    request.insert("optional_products".into(), json!(["investments"]));
    request.insert("language".into(), json!("en"));
    request.insert("redirect_uri".into(), json!(format!("https://{host_name}/config")));
    request.insert("webhook".into(), json!(format!("https://{host_name}/api/plaid-hook")));
    match access_token.filter(|token| !token.is_empty()) {
        Some(access_token) => {
            request.insert("access_token".into(), json!(access_token));
            request.insert("update".into(), json!({ "account_selection_enabled": true }));
        }
        None => {
            request.insert("products".into(), json!(["transactions"]));
        }
    }
    Json::Object(request)
}

/// Creates a link token; answers Plaid's response data (`link_token`,
/// `expiration`, `request_id`).
pub async fn get_link_token(user: &MaskedUser, access_token: Option<&str>) -> anyhow::Result<Json> {
    let client = get_client(Some(user))?;
    client.call("/link/token/create", &link_token_request(user, access_token)).await
}

/// Exchanges a public token from Link for the item's access token; answers
/// the response data unchanged (`access_token`, `item_id`).
pub async fn exchange_public_token(user: &MaskedUser, public_token: &str) -> anyhow::Result<Json> {
    exchange_public_token_with(&get_client(Some(user))?, public_token).await
}

/// [`exchange_public_token`] on a given client: the TypeScript's `deps` seam.
pub async fn exchange_public_token_with(client: &PlaidClient, public_token: &str) -> anyhow::Result<Json> {
    client.call("/item/public_token/exchange", &json!({ "public_token": public_token })).await
}

/// The item an access token belongs to (`response.data.item`), on the default
/// client; `None` when the answer carries none.
pub async fn get_item(access_token: &str) -> anyhow::Result<Option<Json>> {
    let client = get_client(None)?;
    let data = client.call("/item/get", &json!({ "access_token": access_token })).await?;
    Ok(data.get("item").cloned())
}

/// Removes the item at Plaid; answers the response data.
pub async fn delete_item(user: &MaskedUser, item: &Json) -> anyhow::Result<Json> {
    let client = get_client(Some(user))?;
    // `{ access_token }`: a missing token is left out, as `JSON.stringify` leaves out `undefined`.
    let mut request = Obj::new();
    if let Some(access_token) = item.get("access_token") {
        request.insert("access_token".into(), access_token.clone());
    }
    client.call("/item/remove", &Json::Object(request)).await
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::server::plaid::util::PlaidError;

    // `tokens.test.ts`, "exchangePublicToken".

    fn user() -> MaskedUser {
        MaskedUser { user_id: "u-1".to_string(), username: "test".to_string() }
    }

    #[tokio::test]
    async fn returns_the_exchanged_access_token_and_item_id_and_passes_the_public_token_through() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let recorder = seen.clone();
        let client = PlaidClient::answering(move |endpoint, body| {
            recorder.lock().unwrap().push((endpoint.to_string(), body.clone()));
            Ok(json!({ "access_token": "access-sandbox-1", "item_id": "item-1" }))
        });

        let result = exchange_public_token_with(&client, "public-sandbox-1").await.unwrap();

        assert_eq!(result, json!({ "access_token": "access-sandbox-1", "item_id": "item-1" }));
        assert_eq!(
            *seen.lock().unwrap(),
            vec![("/item/public_token/exchange".to_string(), json!({ "public_token": "public-sandbox-1" }))]
        );
    }

    #[tokio::test]
    async fn propagates_an_exchange_failure_instead_of_answering_with_a_partial_token() {
        let client = PlaidClient::answering(|_, _| Err(PlaidError::transport("INVALID_PUBLIC_TOKEN")));
        let error = exchange_public_token_with(&client, "public-bad").await.unwrap_err();
        assert_eq!(error.to_string(), "INVALID_PUBLIC_TOKEN");
    }

    #[tokio::test]
    async fn returns_malformed_response_data_unchanged() {
        // Pinning the current contract: the caller destructures access_token
        // and item_id from this return, so a shape missing either surfaces as
        // undefined downstream.
        let client = PlaidClient::answering(|_, _| Ok(json!({})));
        assert_eq!(exchange_public_token_with(&client, "public-sandbox-1").await.unwrap(), json!({}));
    }

    #[test]
    fn a_new_link_asks_for_transactions_and_update_mode_names_the_item() {
        let new_link = link_token_request(&user(), None);
        assert_eq!(new_link["products"], json!(["transactions"]));
        assert!(new_link.get("access_token").is_none());
        assert_eq!(link_token_request(&user(), Some("")), new_link);

        let update = link_token_request(&user(), Some("access-1"));
        assert_eq!(update["access_token"], json!("access-1"));
        assert_eq!(update["update"], json!({ "account_selection_enabled": true }));
        assert!(update.get("products").is_none());
        assert_eq!(update["user"], json!({ "client_user_id": "u-1" }));
        assert_eq!(update["optional_products"], json!(["investments"]));
    }
}
