//! `DELETE /budget`: `src/server/routes/budgets/delete-budget.ts`.

use crate::server::entity_routes::make_delete_entity_route;
use crate::server::postgres::repositories::budgets::delete_budget;
use crate::server::route::Route;

pub fn routes() -> Vec<Route> {
    vec![make_delete_entity_route("/budget", |user, id| Box::pin(delete_budget(user, id)))]
}
