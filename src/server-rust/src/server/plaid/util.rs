//! The Plaid API client: `src/server/lib/plaid/util.ts`.
//!
//! The TypeScript uses the `plaid` SDK, whose generated client POSTs a JSON
//! body to `<base path>/<endpoint>` with the credentials in headers, through
//! axios. Here the same request is made directly, and a failure is reported
//! the way axios reports it (see [`PlaidError`]), since callers branch on the
//! `error_code` of the answer.

use std::sync::{Arc, LazyLock, OnceLock};

use futures::future::BoxFuture;

use crate::js::{json_parse, json_stringify, Json};
use crate::server::alarm::http_client;
use crate::server::logger;
use crate::server::postgres::models::MaskedUser;

/// `PlaidEnvironments.production`.
pub const PLAID_PRODUCTION: &str = "https://production.plaid.com";
/// `PlaidEnvironments.sandbox`.
pub const PLAID_SANDBOX: &str = "https://sandbox.plaid.com";

/// The headers the SDK adds to every request beside the credentials.
const SDK_USER_AGENT: &str = "Plaid Node v31.1.0";
const PLAID_VERSION: &str = "2020-09-14";

/// The Plaid settings of the environment, read once.
struct PlaidEnv {
    client_id: Option<String>,
    secret_production: Option<String>,
    secret_development: Option<String>,
    secret_sandbox: Option<String>,
}

static ENV: LazyLock<PlaidEnv> = LazyLock::new(|| PlaidEnv {
    client_id: std::env::var("PLAID_CLIENT_ID").ok(),
    secret_production: std::env::var("PLAID_SECRET_PRODUCTION").ok(),
    secret_development: std::env::var("PLAID_SECRET_DEVELOPMENT").ok(),
    secret_sandbox: std::env::var("PLAID_SECRET_SANDBOX").ok(),
});

/// A set environment variable with something in it: what `!!process.env.X` tests.
fn present(value: &Option<String>) -> bool {
    value.as_deref().is_some_and(|value| !value.is_empty())
}

/// Whether the client id, a production or development secret, and the
/// sandbox secret are all set.
pub fn is_plaid_configured() -> bool {
    let env = &*ENV;
    present(&env.client_id)
        && (present(&env.secret_production) || present(&env.secret_development))
        && present(&env.secret_sandbox)
}

/// Warns at start-up when Plaid is not configured, as loading the module does
/// in the TypeScript.
pub fn warn_if_not_configured() {
    if !is_plaid_configured() {
        logger::warn("Plaid is not configured. Check env vars.", None, None);
    }
}

const NOT_CONFIGURED: &str = "Plaid is not configured — refusing to make Plaid API calls";

/// How a Plaid call failed, as axios reports it: `message` is the error's
/// message (`Request failed with status code 400` for a non-2xx answer, the
/// transport's own words otherwise) and `response_data` is
/// `error.response.data`, the answer's body (parsed when it is JSON), absent
/// when no answer came back.
#[derive(Clone, Debug, PartialEq)]
pub struct PlaidError {
    pub message: String,
    pub status: Option<u16>,
    pub response_data: Option<Json>,
}

impl std::fmt::Display for PlaidError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for PlaidError {}

impl PlaidError {
    /// A non-2xx answer with this body.
    pub fn from_response(status: u16, response_data: Json) -> Self {
        PlaidError { message: format!("Request failed with status code {status}"), status: Some(status), response_data: Some(response_data) }
    }

    /// A failure with no answer: the host was unreachable or the connection broke.
    pub fn transport(message: impl Into<String>) -> Self {
        PlaidError { message: message.into(), status: None, response_data: None }
    }

    /// `error.response.data.error_code`.
    pub fn error_code(&self) -> Option<&Json> {
        self.response_data.as_ref().and_then(|data| data.get("error_code"))
    }
}

/// `(error as { response?: { data?: PlaidError } })?.response?.data`: the body
/// of the answer when `error` is a failed Plaid call that got one.
pub fn plaid_error_of(error: &anyhow::Error) -> Option<&Json> {
    error.downcast_ref::<PlaidError>().and_then(|error| error.response_data.as_ref())
}

/// `plaidError?.error_code` as text, when it is a string.
pub fn error_code_of(plaid_error: Option<&Json>) -> Option<&str> {
    plaid_error.and_then(|data| data.get("error_code")).and_then(Json::as_str)
}

/// `plaidError.error_type === PlaidErrorType.ItemError`.
pub fn is_item_error(plaid_error: Option<&Json>) -> bool {
    plaid_error.and_then(|data| data.get("error_type")).and_then(Json::as_str) == Some("ITEM_ERROR")
}

/// What a fake transport answers one call with: `(endpoint, body)` to the
/// answer's data or the failure.
pub type FakeTransport = Arc<dyn Fn(&str, &Json) -> BoxFuture<'static, Result<Json, PlaidError>> + Send + Sync>;

#[derive(Clone)]
enum Transport {
    Http,
    Fake(FakeTransport),
}

/// A Plaid API client bound to one environment and secret: `PlaidApi`.
#[derive(Clone)]
pub struct PlaidClient {
    base_path: &'static str,
    client_id: Option<String>,
    secret: Option<String>,
    transport: Transport,
}

impl std::fmt::Debug for PlaidClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PlaidClient").field("base_path", &self.base_path).finish_non_exhaustive()
    }
}

impl PlaidClient {
    /// A client that answers from `transport` instead of the network: the
    /// seam the TypeScript's injected `getClient` dependencies give its tests.
    pub fn fake(transport: FakeTransport) -> Self {
        PlaidClient { base_path: PLAID_PRODUCTION, client_id: None, secret: None, transport: Transport::Fake(transport) }
    }

    /// A fake client whose every call is answered at once by `answer`.
    pub fn answering<F>(answer: F) -> Self
    where
        F: Fn(&str, &Json) -> Result<Json, PlaidError> + Send + Sync + 'static,
    {
        let transport: FakeTransport = Arc::new(move |endpoint: &str, body: &Json| {
            let answer = answer(endpoint, body);
            Box::pin(async move { answer })
        });
        Self::fake(transport)
    }

    /// The environment this client calls.
    pub fn base_path(&self) -> &'static str {
        self.base_path
    }

    /// POSTs `body` to `endpoint` (`/link/token/create`) and answers with the
    /// response's data: its parsed JSON, or its text when it is not JSON.
    pub async fn request(&self, endpoint: &str, body: &Json) -> Result<Json, PlaidError> {
        if let Transport::Fake(transport) = &self.transport {
            return transport(endpoint, body).await;
        }
        let mut request = http_client()
            .post(format!("{}{}", self.base_path, endpoint))
            .header("Accept", "application/json, text/plain, */*")
            .header("Content-Type", "application/json")
            .header("User-Agent", SDK_USER_AGENT)
            .header("Plaid-Version", PLAID_VERSION);
        if let Some(client_id) = &self.client_id {
            request = request.header("PLAID-CLIENT-ID", client_id);
        }
        if let Some(secret) = &self.secret {
            request = request.header("PLAID-SECRET", secret);
        }
        let response = request.body(json_stringify(body)).send().await.map_err(|error| PlaidError::transport(error.to_string()))?;
        let status = response.status().as_u16();
        let text = response.text().await.map_err(|error| PlaidError::transport(error.to_string()))?;
        // axios parses a JSON answer and leaves anything else as text.
        let data = json_parse(&text).unwrap_or(Json::String(text));
        if (200..300).contains(&status) {
            Ok(data)
        } else {
            Err(PlaidError::from_response(status, data))
        }
    }

    /// `client.<method>(request)` for a method that answers `response.data`.
    pub(crate) async fn call(&self, endpoint: &str, body: &Json) -> anyhow::Result<Json> {
        Ok(self.request(endpoint, body).await?)
    }
}

/// The client for `user`: the sandbox for the demo user, otherwise production
/// with the production secret, or with the development secret when there is
/// no production one. The SDK has no development environment any more, so
/// that client calls production too.
pub fn get_client(user: Option<&MaskedUser>) -> anyhow::Result<PlaidClient> {
    if !is_plaid_configured() {
        anyhow::bail!(NOT_CONFIGURED);
    }
    let env = &*ENV;
    let is_demo = user.is_some_and(|user| user.username == "demo");
    let (base_path, secret) = if is_demo {
        (PLAID_SANDBOX, env.secret_sandbox.clone())
    } else if present(&env.secret_production) {
        (PLAID_PRODUCTION, env.secret_production.clone())
    } else {
        (PLAID_PRODUCTION, env.secret_development.clone())
    };
    Ok(PlaidClient { base_path, client_id: env.client_id.clone(), secret, transport: Transport::Http })
}

/// A production client, for what needs production credentials (webhook
/// verification): webhooks are only sent from production.
pub fn get_production_client() -> anyhow::Result<PlaidClient> {
    if !is_plaid_configured() {
        anyhow::bail!(NOT_CONFIGURED);
    }
    static PRODUCTION_CLIENT: OnceLock<PlaidClient> = OnceLock::new();
    Ok(PRODUCTION_CLIENT
        .get_or_init(|| {
            let env = &*ENV;
            if !present(&env.secret_production) {
                logger::warn(
                    "Production secret not configured - webhook verification will fail",
                    Some(&crate::ctx! { "component": "plaid" }),
                    None,
                );
            }
            PlaidClient {
                base_path: PLAID_PRODUCTION,
                client_id: env.client_id.clone(),
                secret: env.secret_production.clone(),
                transport: Transport::Http,
            }
        })
        .clone())
}

/// Error codes a sync treats as "nothing to fetch" rather than a failure.
pub const IGNORABLE_ERROR_CODES: &[&str] = &["NO_INVESTMENT_ACCOUNTS"];

/// `ignorable_error_codes.has(code)`.
pub fn is_ignorable_error_code(code: &str) -> bool {
    IGNORABLE_ERROR_CODES.contains(&code)
}

/// An error whose message is the `JSON.stringify` of a value: how the logger
/// prints a thrown value that is a plain object, such as a Plaid error body.
pub(crate) fn logged_value(value: &Json) -> anyhow::Error {
    match value {
        Json::String(text) => anyhow::anyhow!("{text}"),
        other => anyhow::anyhow!("{}", json_stringify(other)),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_non_2xx_answer_fails_with_the_axios_message_and_keeps_the_body() {
        let error = PlaidError::from_response(400, json!({ "error_code": "ITEM_LOGIN_REQUIRED", "error_type": "ITEM_ERROR" }));
        assert_eq!(error.to_string(), "Request failed with status code 400");
        let error = anyhow::Error::new(error);
        assert_eq!(error_code_of(plaid_error_of(&error)), Some("ITEM_LOGIN_REQUIRED"));
        assert!(is_item_error(plaid_error_of(&error)));
    }

    #[test]
    fn a_failure_without_an_answer_has_no_body() {
        let error = anyhow::Error::new(PlaidError::transport("socket hang up"));
        assert_eq!(plaid_error_of(&error), None);
        assert_eq!(error_code_of(plaid_error_of(&error)), None);
        assert!(!is_item_error(None));
    }

    #[test]
    fn only_no_investment_accounts_is_ignorable() {
        assert!(is_ignorable_error_code("NO_INVESTMENT_ACCOUNTS"));
        assert!(!is_ignorable_error_code("PRODUCTS_NOT_SUPPORTED"));
    }

    #[tokio::test]
    async fn a_fake_client_answers_from_its_transport() {
        let client = PlaidClient::answering(|endpoint, body| Ok(json!({ "endpoint": endpoint, "body": body })));
        assert_eq!(
            client.request("/item/get", &json!({ "access_token": "a" })).await.unwrap(),
            json!({ "endpoint": "/item/get", "body": { "access_token": "a" } })
        );
    }
}
