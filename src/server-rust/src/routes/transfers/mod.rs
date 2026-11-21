//! Transfer pairs. `src/server/routes/transfers/`.

pub mod get_transfers;
pub mod post_transfer_pair;
pub mod reject_transfer;

use crate::server::route::Route;

pub fn routes() -> Vec<Route> {
    let mut routes = Vec::new();
    routes.extend(get_transfers::routes());
    routes.extend(post_transfer_pair::routes());
    routes.extend(reject_transfer::routes());
    routes
}
