//! The server-sent event stream. `src/server/routes/events/`.

pub mod get_events;

use crate::server::route::Route;

pub fn routes() -> Vec<Route> {
    let mut routes = Vec::new();
    routes.extend(get_events::routes());
    routes
}
