//! `GET /new-category`: `src/server/routes/budgets/get-new-category.ts`.

use crate::server::entity_routes::{make_get_new_entity_route, GetNewEntityOptions};
use crate::server::postgres::repositories::budgets::create_category;
use crate::server::route::Route;

pub fn routes() -> Vec<Route> {
    vec![make_get_new_entity_route(
        "/new-category",
        |user, data| Box::pin(create_category(user, data)),
        GetNewEntityOptions {
            parent_field: Some("section_id"),
            body_key: "category",
            failure_message: "Failed to create category.",
        },
    )]
}
