//! Every API endpoint, grouped as in `src/server/routes/`.

pub mod client_error;
pub mod health;
pub mod users;

use crate::server::route::Route;

/// All routes. A request matches on exact path and method.
pub fn all() -> Vec<Route> {
    let mut routes = Vec::new();
    routes.extend(client_error::routes());
    routes.extend(health::routes());
    routes.extend(users::routes());
    routes
}
