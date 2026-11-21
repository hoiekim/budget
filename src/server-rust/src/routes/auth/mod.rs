//! Single sign-on: sign-in, callback, identity provider events. `src/server/routes/auth/`.

pub mod get_auth_callback;
pub mod get_auth_login;
pub mod post_auth_events;

use crate::server::route::Route;

pub fn routes() -> Vec<Route> {
    let mut routes = Vec::new();
    routes.extend(get_auth_callback::routes());
    routes.extend(get_auth_login::routes());
    routes.extend(post_auth_events::routes());
    routes
}
