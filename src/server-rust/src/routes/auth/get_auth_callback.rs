//! `GET /auth/callback`: `src/server/routes/auth/get-auth-callback.ts`.

use crate::common::constants::sso_error;
use crate::js::{truthy_opt, Json, JsDate};
use crate::server::auth_client::AuthError;
use crate::server::logger;
use crate::server::node_env::is_production;
use crate::server::postgres::models::SessionAuth;
use crate::server::route::{Ctx, HandlerResult, Route};
use crate::server::session::{build_session_cookie, build_session_data, session_store, SESSION_MAX_AGE_S, SSO_RECHECK_INTERVAL_MS};
use crate::server::sso::get_sso;
use crate::server::sso::http::{redirect_response, sign_in_page_redirect, to_fetch_request, unknown_route};
use crate::server::sso::users::find_or_create_sso_user;

/// Why a sign-in the client refused failed, as the sign-in page shows it;
/// `None` for an error that isn't a refusal.
fn refusal_of(error: &AuthError) -> Option<&'static str> {
    match error {
        AuthError::Unavailable(_) => Some(sso_error::UNAVAILABLE),
        AuthError::Login { code: "authorization_error", error } if error.as_deref() == Some("access_denied") => {
            Some(sso_error::NO_ACCESS)
        }
        AuthError::Login { code: "authorization_error" | "missing_code", .. } => Some(sso_error::FAILED),
        AuthError::Login { .. } => Some(sso_error::EXPIRED),
        AuthError::InvalidToken(_) | AuthError::InvalidGrant(_) => Some(sso_error::FAILED),
        AuthError::Other(_) => None,
    }
}

/// Where the identity provider sends the browser back: completes the
/// sign-in, finds or creates its user, and starts the session.
async fn get_auth_callback(ctx: &mut Ctx) -> HandlerResult {
    let Some(sso) = get_sso() else { return Ok(unknown_route(ctx).into()) };

    let login = match sso.client.finish_login(to_fetch_request(&ctx.req)).await {
        Ok(login) => login,
        Err(error) => {
            let Some(refusal) = refusal_of(&error) else { return Err(error.into()) };
            logger::warn(
                "Single sign-on did not complete",
                Some(&crate::ctx! { "component": "sso", "refusal": refusal }),
                Some(&anyhow::Error::new(error)),
            );
            return Ok(sign_in_page_redirect(refusal, None));
        }
    };

    // Budget has no roles of its own: any role is access.
    if !truthy_opt(login.claims.get("role")) {
        return Ok(sign_in_page_redirect(sso_error::NO_ACCESS, Some(&login.clear_cookie)));
    }

    let claim = |name: &str| login.claims.get(name).and_then(Json::as_str).unwrap_or_default();
    let found =
        find_or_create_sso_user(claim("sub"), claim("username"), login.id_claims.get("email"), &sso.config.link_users).await?;
    let user = match found {
        Ok(user) => user,
        Err(refusal) => {
            logger::warn("Single sign-on refused", Some(&crate::ctx! { "component": "sso", "refusal": refusal }), None);
            return Ok(sign_in_page_redirect(refusal, Some(&login.clear_cookie)));
        }
    };

    ctx.session.regenerate().await;
    let secure = is_production();
    let auth = SessionAuth {
        sid: claim("sid").to_string(),
        refresh_token: login.refresh_token.clone(),
        recheck_at: JsDate::from_ms(JsDate::now_ms() + SSO_RECHECK_INTERVAL_MS),
    };
    session_store().set(&ctx.session.id, &build_session_data(&user, secure, Some(auth))).await?;
    redirect_response(&login.return_to, &[&login.clear_cookie, &build_session_cookie(&ctx.session.id, SESSION_MAX_AGE_S, secure)])
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("GET", "/auth/callback", get_auth_callback)]
}
