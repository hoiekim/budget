//! `Authorization: Bearer` credentials against the API-key store:
//! `src/server/lib/bearer-auth.ts`.

use std::net::{Ipv4Addr, Ipv6Addr};

use crate::server::auth_client::AuthError;
use crate::server::postgres::models::MaskedUser;
use crate::server::postgres::repositories::api_keys::verify_api_key;
use crate::server::postgres::repositories::users::{get_masked_user_by_id, get_user_by_auth_sub};
use crate::server::sso::get_sso;

const BEARER_PREFIX: &str = "Bearer ";

/// The identity provider could not say whether a key is good.
#[derive(Debug)]
pub struct Unavailable;

/// `net.isIP(text) !== 0`. An IPv6 address may name its zone (`fe80::1%eth0`),
/// in letters, digits, `-`, `.` and `:`.
pub fn is_ip(text: &str) -> bool {
    if text.parse::<Ipv4Addr>().is_ok() {
        return true;
    }
    let (address, zone) = match text.split_once('%') {
        Some((address, zone)) => (address, Some(zone)),
        None => (text, None),
    };
    let zone_is_valid =
        |zone: &str| !zone.is_empty() && zone.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b':'));
    zone.map(zone_is_valid).unwrap_or(true) && address.parse::<Ipv6Addr>().is_ok()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_address_is_told_from_everything_else_the_way_net_is_ip_does() {
        for address in [
            "1.2.3.4",
            "0.0.0.0",
            "255.255.255.255",
            "::",
            "::1",
            "2001:db8::",
            "1:2:3:4:5:6:7:8",
            "1:2:3:4:5:6:7::",
            "::2:3:4:5:6:7:8",
            "::FFFF",
            "::ffff:1.2.3.4",
            "1:2:3:4:5:6:1.2.3.4",
            "fe80::1%eth0",
            "fe80::1%eth0.1",
            "fe80::1%25eth0",
            "::1%1",
            "::1%-.:",
        ] {
            assert!(is_ip(address), "{address}");
        }
        for other in [
            "",
            "unknown",
            "gateway.internal",
            "1.2.3",
            "1.2.3.4.5",
            "1.2.3.256",
            "01.2.3.4",
            "1.2.3.04",
            "0x1.2.3.4",
            "1.2.3.4 ",
            " 1.2.3.4",
            "1.2.3.4:80",
            "1.2.3.4%eth0",
            "[::1]",
            ":::1",
            "1::2::3",
            "1:2:3:4:5:6:7",
            "1:2:3:4:5:6:7:8:9",
            "1:2:3:4:5:6:7::8",
            "12345::",
            "g::1",
            "::01.2.3.4",
            "::ffff:1.2.3",
            "::1%",
            "::1%eth_0",
            "::1%a b",
            "::1%eth0%x",
            "::1%é",
            "198.51.100.23, 10.0.0.1",
        ] {
            assert!(!is_ip(other), "{other}");
        }
    }
}
