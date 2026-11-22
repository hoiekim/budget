//! `GET /securities`: `src/server/routes/accounts/get-securities.ts`.

use crate::js::Json;
use crate::server::postgres::repositories::securities::get_securities_for_user;
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};

/// The securities any holding of the user, or of someone sharing data with
/// them, refers to, deleted holdings included.
async fn get_securities(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let securities = get_securities_for_user(&user).await?;
    Ok(ApiResponse::success_with(Json::Array(securities)).into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("GET", "/securities", get_securities)]
}
