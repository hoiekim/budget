//! Budgets, sections and categories. `src/server/routes/budgets/`.

pub mod delete_budget;
pub mod delete_category;
pub mod delete_section;
pub mod get_budgets;
pub mod get_new_budget;
pub mod get_new_category;
pub mod get_new_section;
pub mod post_budget;
pub mod post_category;
pub mod post_section;

use crate::server::route::Route;

pub fn routes() -> Vec<Route> {
    let mut routes = Vec::new();
    routes.extend(delete_budget::routes());
    routes.extend(delete_category::routes());
    routes.extend(delete_section::routes());
    routes.extend(get_budgets::routes());
    routes.extend(get_new_budget::routes());
    routes.extend(get_new_category::routes());
    routes.extend(get_new_section::routes());
    routes.extend(post_budget::routes());
    routes.extend(post_category::routes());
    routes.extend(post_section::routes());
    routes
}
