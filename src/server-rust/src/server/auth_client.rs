//! The app side of single sign-on: discovery, the code flow with PKCE, JWKS,
//! introspection of API keys with its cache, and security events. A port of
//! the vendored `src/server/lib/auth-client.ts`.

use std::fmt;

pub use super::auth_client_impl::AuthClient;

/// Why a call to the identity provider did not produce an answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthError {
    /// The provider refused a code or refresh token: end the session.
    InvalidGrant(String),
    /// The provider could not be reached, timed out, or failed on its side.
    Unavailable(String),
    /// A token or event failed verification.
    InvalidToken(String),
    /// The callback can't complete this sign-in; start a new one. `code` is one of
    /// `no_login_cookie`, `login_expired`, `state_mismatch`, `authorization_error`, `missing_code`.
    Login { code: &'static str, error: Option<String> },
    /// Anything else: a misconfiguration or an answer the client cannot use.
    Other(String),
}

impl fmt::Display for AuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AuthError::InvalidGrant(message)
            | AuthError::Unavailable(message)
            | AuthError::InvalidToken(message)
            | AuthError::Other(message) => write!(f, "{message}"),
            AuthError::Login { code, error: Some(error) } => write!(f, "{code}: {error}"),
            AuthError::Login { code, error: None } => write!(f, "{code}"),
        }
    }
}

impl std::error::Error for AuthError {}

#[derive(Clone, Debug)]
pub struct AuthClientOptions {
    /// The issuer URL, exactly as tokens carry it in `iss`.
    pub issuer: String,
    /// A private-network URL for the same service, used for every server-to-server call.
    pub back_channel_url: Option<String>,
    pub client_id: String,
    /// Leave out for a public client.
    pub client_secret: Option<String>,
    pub redirect_uri: String,
    /// The `aud` of this app's access tokens and events. Defaults to `client_id`.
    pub audience: Option<String>,
}

use crate::js::Obj;

/// The verified claims of an access token. `sub`, `sid`, `username`, `name` and `role` are strings.
pub type AccessClaims = Obj;
/// The verified claims of an ID token.
pub type IdClaims = Obj;

#[derive(Clone, Debug, Default)]
pub struct StartLoginOptions {
    /// A local path to land on after sign-in. Anything else is replaced with "/".
    pub return_to: Option<String>,
    pub max_age: Option<i64>,
    /// `"none"` or `"login"`.
    pub prompt: Option<String>,
    pub login_hint: Option<String>,
}

pub struct StartedLogin {
    pub redirect_url: String,
    /// The `Set-Cookie` value that carries the sign-in to the callback.
    pub login_cookie: String,
}

pub struct Login {
    pub claims: AccessClaims,
    pub id_claims: IdClaims,
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub return_to: String,
    /// A `Set-Cookie` value that deletes the login cookie.
    pub clear_cookie: String,
}

pub struct Refreshed {
    pub claims: AccessClaims,
    pub access_token: String,
    /// Present when the provider rotated the refresh token.
    pub refresh_token: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Introspection {
    pub sub: String,
    pub username: String,
    pub role: String,
    pub scopes: Vec<String>,
    /// The credential's id, which `credential.revoked` names.
    pub id: Option<String>,
}

/// A verified security event. Unknown types carry `type` and `jti` only.
#[derive(Clone, Debug, Default)]
pub struct AuthEvent {
    pub event_type: String,
    pub jti: String,
    pub sub: Option<String>,
    pub sid: Option<String>,
    /// On `access.changed`: `Some(Some(role))` for the new role, `Some(None)` when access was removed.
    pub role: Option<Option<String>>,
    pub id: Option<String>,
    pub invite: Option<String>,
}

/// What the client reads of the incoming request: its URL and its `Cookie` header.
pub struct IncomingRequest<'a> {
    pub url: &'a str,
    pub cookie: Option<&'a str>,
}
