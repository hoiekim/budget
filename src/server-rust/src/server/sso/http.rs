//! The responses and request view the single sign-on routes share:
//! `src/server/lib/sso/http.ts`.

use crate::common::constants::SSO_ERROR_PARAM;
use crate::server::auth_client::IncomingRequest;
use crate::server::route::{ApiResponse, Ctx, RawBody, RawResponse, Reply, Request};
use crate::server::security_headers::response_security_headers;

/// Deletes the client's login cookie. The client hands back a `clear_cookie`
/// only for a sign-in that succeeds; this is the same cookie, for the ones
/// that don't.
pub const CLEAR_LOGIN_COOKIE: &str = "__Host-login=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0";

fn redirect(location: &str, cookies: &[&str]) -> Reply {
    let mut headers: Vec<(String, String)> =
        response_security_headers().into_iter().map(|(name, value)| (name.to_string(), value.to_string())).collect();
    headers.push(("Location".to_string(), location.to_string()));
    for cookie in cookies {
        headers.push(("Set-Cookie".to_string(), cookie.to_string()));
    }
    Reply::Raw(RawResponse { status: 302, headers, body: RawBody::Empty })
}

/// A redirect to `location`. Fails, as setting the header does in the
/// TypeScript, on a location a header cannot carry: a header value is a byte
/// string, and a character past U+00FF has no byte.
pub fn redirect_response(location: &str, cookies: &[&str]) -> anyhow::Result<Reply> {
    if location.chars().any(|c| c > '\u{ff}') {
        anyhow::bail!("Header 'Location' has invalid value");
    }
    Ok(redirect(location, cookies))
}

/// Back to the sign-in page, saying why single sign-on did not complete.
/// `clear_login_cookie` defaults to [`CLEAR_LOGIN_COOKIE`].
pub fn sign_in_page_redirect(error: &str, clear_login_cookie: Option<&str>) -> Reply {
    redirect(&format!("/login?{SSO_ERROR_PARAM}={error}"), &[clear_login_cookie.unwrap_or(CLEAR_LOGIN_COOKIE)])
}

/// The request as the client reads it: its URL and its cookies.
pub fn to_fetch_request(req: &Request) -> IncomingRequest<'_> {
    IncomingRequest { url: &req.url, cookie: req.headers.get("cookie").map(String::as_str) }
}

/// What `start.rs` answers for a path no route serves, for the routes that
/// exist only while single sign-on is on.
pub fn unknown_route(ctx: &mut Ctx) -> ApiResponse {
    ctx.status = 404;
    ApiResponse::error("Not Found")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(reply: Reply) -> RawResponse {
        match reply {
            Reply::Raw(raw) => raw,
            _ => panic!("expected a response the route builds itself"),
        }
    }

    fn values<'a>(response: &'a RawResponse, name: &str) -> Vec<&'a str> {
        response.headers.iter().filter(|(header, _)| header == name).map(|(_, value)| value.as_str()).collect()
    }

    #[test]
    fn a_redirect_carries_the_location_each_cookie_and_the_security_headers() {
        let response = raw(redirect_response("/budgets?x=1", &["a=1; Path=/", "b=2; Path=/"]).unwrap());
        assert_eq!(response.status, 302);
        assert!(matches!(response.body, RawBody::Empty));
        assert_eq!(values(&response, "Location"), ["/budgets?x=1"]);
        assert_eq!(values(&response, "Set-Cookie"), ["a=1; Path=/", "b=2; Path=/"]);
        assert_eq!(values(&response, "X-Content-Type-Options"), ["nosniff"]);
        assert_eq!(values(&response, "X-Frame-Options"), ["DENY"]);
    }

    #[test]
    fn a_location_no_header_can_carry_is_refused() {
        assert!(redirect_response("/é?x=ü", &[]).is_ok());
        assert_eq!(redirect_response("/日本", &[]).err().map(|error| error.to_string()).as_deref(), Some("Header 'Location' has invalid value"));
        assert!(redirect_response("/🔑", &[]).is_err());
    }

    #[test]
    fn the_sign_in_page_redirect_says_why_and_deletes_the_login_cookie() {
        let response = raw(sign_in_page_redirect("expired", None));
        assert_eq!(response.status, 302);
        assert_eq!(values(&response, "Location"), ["/login?sso_error=expired"]);
        assert_eq!(values(&response, "Set-Cookie"), [CLEAR_LOGIN_COOKIE]);
        let response = raw(sign_in_page_redirect("no_access", Some("__Host-login=; Max-Age=0")));
        assert_eq!(values(&response, "Location"), ["/login?sso_error=no_access"]);
        assert_eq!(values(&response, "Set-Cookie"), ["__Host-login=; Max-Age=0"]);
    }
}
