//! Recurring charges. `src/server/routes/recurrings/`.

pub mod delete_recurring;
pub mod get_recurrings;
pub mod post_recurring;

use crate::server::route::Route;

pub fn routes() -> Vec<Route> {
    let mut routes = Vec::new();
    routes.extend(delete_recurring::routes());
    routes.extend(get_recurrings::routes());
    routes.extend(post_recurring::routes());
    routes
}
