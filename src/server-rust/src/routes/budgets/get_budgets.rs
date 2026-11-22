//! `GET /budgets`: `src/server/routes/budgets/get-budgets.ts`.

use serde_json::json;

use crate::server::postgres::repositories::budgets::{get_categories, get_sections, search_budgets};
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};

/// The user's budgets, sections and categories, each list whole.
async fn get_budgets(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let (budgets, sections, categories) =
        futures::try_join!(search_budgets(&user, None), get_sections(&user, None), get_categories(&user, None))?;

    Ok(ApiResponse::success_with(json!({ "budgets": budgets, "sections": sections, "categories": categories })).into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("GET", "/budgets", get_budgets)]
}
