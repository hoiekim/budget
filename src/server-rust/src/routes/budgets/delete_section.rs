//! `DELETE /section`: `src/server/routes/budgets/delete-section.ts`.

use crate::server::entity_routes::make_delete_entity_route;
use crate::server::postgres::repositories::budgets::delete_section;
use crate::server::route::Route;

pub fn routes() -> Vec<Route> {
    vec![make_delete_entity_route("/section", |user, id| Box::pin(delete_section(user, id)))]
}
