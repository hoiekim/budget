//! `GET /auth/login`: `src/server/routes/auth/get-auth-login.ts`.

use crate::common::constants::sso_error;
use crate::server::auth_client::{AuthError, StartLoginOptions};
use crate::server::route::{Ctx, HandlerResult, Route};
use crate::server::sso::get_sso;
use crate::server::sso::http::{redirect_response, sign_in_page_redirect, unknown_route};
use crate::server::validation::optional_query_string;

/// Sends the browser to the identity provider to sign in, with the cookie
/// that carries the sign-in to the callback.
async fn get_auth_login(ctx: &mut Ctx) -> HandlerResult {
    let Some(sso) = get_sso() else { return Ok(unknown_route(ctx).into()) };

    let return_to = optional_query_string(&ctx.req, "returnTo").ok().flatten();
    match sso.client.start_login(StartLoginOptions { return_to, ..Default::default() }).await {
        Ok(started) => redirect_response(&started.redirect_url, &[&started.login_cookie]),
        Err(AuthError::Unavailable(_)) => Ok(sign_in_page_redirect(sso_error::UNAVAILABLE, None)),
        Err(error) => Err(error.into()),
    }
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("GET", "/auth/login", get_auth_login)]
}
