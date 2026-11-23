//! `GET /new-section`: `src/server/routes/budgets/get-new-section.ts`.

use crate::server::entity_routes::{make_get_new_entity_route, GetNewEntityOptions};
use crate::server::postgres::repositories::budgets::create_section;
use crate::server::route::Route;

pub fn routes() -> Vec<Route> {
    vec![make_get_new_entity_route(
        "/new-section",
        |user, data| Box::pin(create_section(user, data)),
        GetNewEntityOptions {
            parent_field: Some("budget_id"),
            body_key: "section",
            failure_message: "Failed to create section.",
        },
    )]
}
