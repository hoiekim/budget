//! Webhooks from providers. `src/server/routes/webhooks/`.

pub mod post_plaid_hook;

use crate::server::route::Route;

pub fn routes() -> Vec<Route> {
    let mut routes = Vec::new();
    routes.extend(post_plaid_hook::routes());
    routes
}
