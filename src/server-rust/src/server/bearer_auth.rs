//! `Authorization: Bearer` credentials against the API-key store:
//! `src/server/lib/bearer-auth.ts`.

use std::net::IpAddr;

use crate::server::auth_client::AuthError;
use crate::server::postgres::models::MaskedUser;
use crate::server::postgres::repositories::api_keys::verify_api_key;
use crate::server::postgres::repositories::users::{get_masked_user_by_id, get_user_by_auth_sub};
use crate::server::sso::get_sso;

const BEARER_PREFIX: &str = "Bearer ";

/// The identity provider could not say whether a key is good.
#[derive(Debug)]
pub struct Unavailable;

/// `net.isIP(text) !== 0`.
pub fn is_ip(text: &str) -> bool {
    text.parse::<IpAddr>().is_ok()
}

/// A key budget's own store does not hold, checked with the identity provider
/// instead. Accepted when the provider says it is active, its owner is linked
/// to a local user, and its scopes include the route's.
async fn resolve_introspected_key(plaintext: &str, required_scope: &str, ip: &str) -> anyhow::Result<Result<Option<MaskedUser>, Unavailable>> {
    let Some(sso) = get_sso() else { return Ok(Ok(None)) };
    let answer = match sso.client.introspect(plaintext, Some(ip).filter(|ip| is_ip(ip))).await {
        Ok(answer) => answer,
        Err(AuthError::Unavailable(_)) => return Ok(Err(Unavailable)),
        Err(error) => return Err(error.into()),
    };
    let Some(answer) = answer.filter(|a| a.scopes.iter().any(|scope| scope == required_scope)) else { return Ok(Ok(None)) };
    Ok(Ok(get_user_by_auth_sub(&answer.sub).await?))
}

/// The user an API key authenticates, when no cookie session is present, the
/// matched route declares a scope, and the key is live and carries that scope.
/// `Ok(None)` means "no bearer credentials applied".
pub async fn resolve_bearer_auth(
    authorization_header: Option<&str>,
    has_cookie_session: bool,
    required_scope: Option<&str>,
    ip: &str,
) -> anyhow::Result<Result<Option<MaskedUser>, Unavailable>> {
    if has_cookie_session {
        return Ok(Ok(None));
    }
    let Some(required_scope) = required_scope.filter(|scope| !scope.is_empty()) else { return Ok(Ok(None)) };
    let Some(raw) = authorization_header.filter(|raw| raw.starts_with(BEARER_PREFIX)) else { return Ok(Ok(None)) };
    let plaintext = crate::server::validation::js_trim(&raw[BEARER_PREFIX.len()..]);
    if plaintext.is_empty() {
        return Ok(Ok(None));
    }
    let Some(resolved) = verify_api_key(plaintext).await? else {
        return resolve_introspected_key(plaintext, required_scope, ip).await;
    };
    if !resolved.scopes.iter().any(|scope| scope == required_scope) {
        return Ok(Ok(None));
    }
    Ok(Ok(get_masked_user_by_id(&resolved.user_id).await?))
}
