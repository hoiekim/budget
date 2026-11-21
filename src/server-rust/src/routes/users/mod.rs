//! Sign-in and bank connections. `src/server/routes/users/`.

pub mod delete_item;
pub mod get_link_token;
pub mod login;
pub mod post_public_token;

use crate::server::route::Route;

pub fn routes() -> Vec<Route> {
    let mut routes = Vec::new();
    routes.push(crate::route!("GET", "/login", login::get_login));
    routes.push(crate::route!("POST", "/login", login::post_login));
    routes.push(crate::route!("DELETE", "/login", login::delete_login));
    routes.extend(delete_item::routes());
    routes.extend(get_link_token::routes());
    routes.extend(post_public_token::routes());
    routes
}
