//! `DELETE /category`: `src/server/routes/budgets/delete-category.ts`.

use crate::server::entity_routes::make_delete_entity_route;
use crate::server::postgres::repositories::budgets::delete_category;
use crate::server::route::Route;

pub fn routes() -> Vec<Route> {
    vec![make_delete_entity_route("/category", |user, id| Box::pin(delete_category(user, id)))]
}
