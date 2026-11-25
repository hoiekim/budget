//! `GET`, `POST` and `DELETE /login`: `src/server/routes/users/{get,post,delete}-login.ts`.

use serde_json::json;

use crate::js::Obj;
use crate::server::logger;
use crate::server::password::verify_password;
use crate::server::postgres::repositories::users::{mask_user, search_password_user};
use crate::server::postgres::VERSION;
use crate::server::rate_limit::{pre_session_shed_message, LOGIN_RATE_LIMITER};
use crate::server::route::{ApiResponse, Ctx, HandlerResult};
use crate::server::sso::{get_sso, sso_mode};
use crate::server::validation::{require_body_object, require_string_field, validation_error};

/// Who is signed in, and how the sign-in page should offer to sign in.
pub async fn get_login(ctx: &mut Ctx) -> HandlerResult {
    let mut body = Obj::new();
    if let Some(user) = ctx.user() {
        body.insert("user".into(), user.to_json());
    }
    body.insert("app".into(), json!({ "version": VERSION }));
    body.insert("sso".into(), sso_mode().to_json());
    let response = ApiResponse::success_with(body.into());
    Ok(match ctx.user() {
        Some(_) => response,
        None => response.with_message("Not logged in."),
    }
    .into())
}

/// A valid bcrypt hash, compared against when the user is unknown so the
/// answer takes as long as for a real one.
const DUMMY_HASH: &str = "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

pub async fn post_login(ctx: &mut Ctx) -> HandlerResult {
    if !sso_mode().local_login {
        ctx.status = 403;
        return Ok(ApiResponse::failed("Password sign-in is turned off. Sign in with SSO.").into());
    }

    let body = match require_body_object(&ctx.req) {
        Ok(body) => body,
        Err(message) => return Ok(validation_error(message).into()),
    };
    let username = match require_string_field(body, "username") {
        Ok(username) => username,
        Err(message) => return Ok(validation_error(message).into()),
    };
    let password = match require_string_field(body, "password") {
        Ok(password) => password,
        Err(message) => return Ok(validation_error(message).into()),
    };

    // Checked and charged before the first await, so a burst of concurrent
    // attempts can't all pass the check before any is counted. Only failures
    // keep their slot.
    let ip = ctx.req.ip.clone();
    if let Some(message) = pre_session_shed_message(&ctx.req.method, "/login", &ip) {
        ctx.status = 429;
        return Ok(ApiResponse::failed(message).into());
    }
    LOGIN_RATE_LIMITER.consume(&ip, 1);

    // While single sign-on is on, the provider governs a linked account.
    let user = match search_password_user(&username, sso_mode().enabled).await {
        Ok(user) => user,
        Err(error) => {
            // A lookup that fails isn't a failed login.
            LOGIN_RATE_LIMITER.refund(&ip, 1);
            return Err(error);
        }
    };

    let matches = match &user {
        Some(user) => verify_password(&password, &user.password).await?,
        None => {
            verify_password(&password, DUMMY_HASH).await?;
            false
        }
    };

    if let (true, Some(user)) = (matches, &user) {
        // A success hands back its own slot and leaves the rest.
        LOGIN_RATE_LIMITER.refund(&ip, 1);
        let masked = mask_user(user);
        // A fresh session id, so one planted before sign-in is never promoted.
        ctx.session.regenerate().await?;
        ctx.session.user = Some(masked.clone());
        return Ok(ApiResponse::success_with(masked.to_json()).into());
    }

    // The same message whether or not the username exists.
    Ok(ApiResponse::failed("Invalid username or password.").into())
}

pub async fn delete_login(ctx: &mut Ctx) -> HandlerResult {
    let auth = ctx.session.auth.clone();
    let sso = get_sso();

    // The revoke goes first: if the store delete fails, the surviving row is ended at its next re-check.
    if let (Some(refresh_token), Some(sso)) = (auth.as_ref().and_then(|auth| auth.refresh_token.clone()), &sso) {
        let revoking = sso.clone();
        tokio::spawn(async move {
            if let Err(error) = revoking.client.revoke(&refresh_token).await {
                logger::warn(
                    "Failed to revoke the single sign-on refresh token",
                    Some(&crate::ctx! { "component": "sso" }),
                    Some(&anyhow::Error::new(error)),
                );
            }
        });
    }
    ctx.session.destroy().await?;

    let (Some(_), Some(sso)) = (auth, sso) else { return Ok(ApiResponse::success().into()) };
    match sso.client.logout_url(Some(&sso.config.post_logout_redirect)).await {
        Ok(logout_url) if !logout_url.is_empty() => Ok(ApiResponse::success_with(json!({ "logoutUrl": logout_url })).into()),
        Ok(_) => Ok(ApiResponse::success().into()),
        Err(error) => {
            logger::warn(
                "Failed to build the single sign-on logout URL",
                Some(&crate::ctx! { "component": "sso" }),
                Some(&anyhow::Error::new(error)),
            );
            Ok(ApiResponse::success().into())
        }
    }
}
