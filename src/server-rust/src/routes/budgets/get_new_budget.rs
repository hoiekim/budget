//! `GET /new-budget`: `src/server/routes/budgets/get-new-budget.ts`.

use crate::server::entity_routes::{make_get_new_entity_route, GetNewEntityOptions};
use crate::server::postgres::repositories::budgets::create_budget;
use crate::server::route::Route;

pub fn routes() -> Vec<Route> {
    vec![make_get_new_entity_route(
        "/new-budget",
        |user, data| Box::pin(create_budget(user, data)),
        GetNewEntityOptions { parent_field: None, body_key: "budget", failure_message: "Failed to create budget." },
    )]
}
