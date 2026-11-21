//! `POST /auth/events`: `src/server/routes/auth/post-auth-events.ts`.

use crate::server::auth_client::AuthError;
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::sso::events::handle_auth_event;
use crate::server::sso::get_sso;
use crate::server::sso::http::unknown_route;

/// The identity provider's security events. Public, with no session or origin
/// check: a token that does not verify against the provider's keys is
/// refused, and a 5xx makes the provider deliver it again.
async fn post_auth_events(ctx: &mut Ctx) -> HandlerResult {
    let Some(sso) = get_sso() else { return Ok(unknown_route(ctx).into()) };

    let event = match sso.client.read_event(ctx.req.raw_body.as_deref().unwrap_or("")).await {
        Ok(event) => event,
        Err(AuthError::InvalidToken(_)) => {
            ctx.status = 400;
            return Ok(ApiResponse::failed("Invalid security event token.").into());
        }
        Err(AuthError::Unavailable(_)) => {
            ctx.status = 503;
            return Ok(ApiResponse::failed("Cannot verify the security event token yet.").into());
        }
        Err(error) => return Err(error.into()),
    };

    handle_auth_event(&event).await?;
    ctx.status = 202;
    Ok(ApiResponse::success().into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("POST", "/auth/events", post_auth_events)]
}
