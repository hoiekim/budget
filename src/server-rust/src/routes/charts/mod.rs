//! Charts and the inflation rate they project with. `src/server/routes/charts/`.

pub mod delete_chart;
pub mod get_charts;
pub mod get_inflation;
pub mod get_new_chart;
pub mod post_chart;

use crate::server::route::Route;

pub fn routes() -> Vec<Route> {
    let mut routes = Vec::new();
    routes.extend(delete_chart::routes());
    routes.extend(get_charts::routes());
    routes.extend(get_inflation::routes());
    routes.extend(get_new_chart::routes());
    routes.extend(post_chart::routes());
    routes
}
