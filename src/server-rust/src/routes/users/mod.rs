//! Sign-in and bank connections: `src/server/routes/users/`.

pub mod login;

use crate::server::route::Route;

pub fn routes() -> Vec<Route> {
    vec![
        crate::route!("GET", "/login", login::get_login),
        crate::route!("POST", "/login", login::post_login),
        crate::route!("DELETE", "/login", login::delete_login),
    ]
}
