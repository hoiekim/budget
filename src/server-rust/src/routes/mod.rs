//! Every API endpoint, grouped as in `src/server/routes/`, one module per
//! TypeScript route file.

pub mod accounts;
pub mod api_keys;
pub mod auth;
pub mod budgets;
pub mod charts;
pub mod client_error;
pub mod events;
pub mod health;
pub mod recurrings;
pub mod transfers;
pub mod users;
pub mod webhooks;

use crate::server::route::Route;

/// All routes. A request matches on exact path and method.
pub fn all() -> Vec<Route> {
    let mut routes = Vec::new();
    routes.extend(accounts::routes());
    routes.extend(api_keys::routes());
    routes.extend(auth::routes());
    routes.extend(budgets::routes());
    routes.extend(charts::routes());
    routes.extend(client_error::routes());
    routes.extend(events::routes());
    routes.extend(health::routes());
    routes.extend(recurrings::routes());
    routes.extend(transfers::routes());
    routes.extend(users::routes());
    routes.extend(webhooks::routes());
    routes
}
