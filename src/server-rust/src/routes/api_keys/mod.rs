//! Scoped API keys. `src/server/routes/api-keys/`.

pub mod delete_api_key;
pub mod get_api_keys;
pub mod post_api_keys;

use crate::server::route::Route;

pub fn routes() -> Vec<Route> {
    let mut routes = Vec::new();
    routes.extend(delete_api_key::routes());
    routes.extend(get_api_keys::routes());
    routes.extend(post_api_keys::routes());
    routes
}
