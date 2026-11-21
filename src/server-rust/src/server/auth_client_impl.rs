//! Placeholder until the client is ported; every call reports the provider unavailable.

use super::auth_client::*;

pub struct AuthClient {
    #[allow(dead_code)]
    options: AuthClientOptions,
}

impl AuthClient {
    pub fn new(options: AuthClientOptions) -> Result<Self, AuthError> {
        Ok(AuthClient { options })
    }

    pub async fn start_login(&self, _options: StartLoginOptions) -> Result<StartedLogin, AuthError> {
        Err(AuthError::Unavailable("not implemented".into()))
    }

    pub async fn finish_login(&self, _request: IncomingRequest<'_>) -> Result<Login, AuthError> {
        Err(AuthError::Unavailable("not implemented".into()))
    }

    pub async fn refresh(&self, _refresh_token: &str) -> Result<Refreshed, AuthError> {
        Err(AuthError::Unavailable("not implemented".into()))
    }

    pub async fn introspect(&self, _secret: &str, _ip: Option<&str>) -> Result<Option<Introspection>, AuthError> {
        Err(AuthError::Unavailable("not implemented".into()))
    }

    pub fn forget(&self, _sub: Option<&str>, _id: Option<&str>) {}

    pub async fn revoke(&self, _refresh_token: &str) -> Result<(), AuthError> {
        Err(AuthError::Unavailable("not implemented".into()))
    }

    pub async fn read_event(&self, _body: &str) -> Result<AuthEvent, AuthError> {
        Err(AuthError::Unavailable("not implemented".into()))
    }

    pub async fn logout_url(&self, _post_logout_redirect: Option<&str>) -> Result<String, AuthError> {
        Err(AuthError::Unavailable("not implemented".into()))
    }
}
