//! `POST /category`: `src/server/routes/budgets/post-category.ts`.

use crate::common::CATEGORY_NAME_REQUIRED_MESSAGE;
use crate::js::{Json, Obj};
use crate::server::entity_routes::{make_update_entity_route, UpdateEntityOptions};
use crate::server::postgres::repositories::budgets::update_category;
use crate::server::route::{ApiResponse, Route};
use crate::server::validation::{js_trim, FieldSpec, FieldType};

/// Typed fields `update_category` writes (`models/category.rs`). `name` is
/// not nullable here even though the column is: the client's
/// `BudgetFamily.name` is a plain string, so a null name renders as a blank
/// selectable option wherever the name is shown.
const CATEGORY_BODY_SPEC: &[FieldSpec] = &[
    FieldSpec::new("category_id", FieldType::Uuid),
    FieldSpec::new("name", FieldType::String).max_length(255),
    FieldSpec::new("roll_over", FieldType::Boolean).nullable(),
    FieldSpec::new("roll_over_start_date", FieldType::Date).nullable(),
    FieldSpec::new("capacities", FieldType::Array),
];

/// The empty-name guard is per-entity (each entity answers with its own
/// message), so it stays an extra check instead of a shared rule.
fn extra_checks(data: &Obj) -> Option<ApiResponse> {
    match data.get("name") {
        Some(Json::String(name)) if js_trim(name).is_empty() => Some(ApiResponse::failed(CATEGORY_NAME_REQUIRED_MESSAGE)),
        _ => None,
    }
}

pub fn routes() -> Vec<Route> {
    vec![make_update_entity_route(
        "/category",
        |user, id, data| Box::pin(update_category(user, id, data)),
        UpdateEntityOptions {
            id_field: "category_id",
            field_spec: CATEGORY_BODY_SPEC,
            entity_label: "category",
            id_log_key: "categoryId",
            extra_checks: Some(extra_checks),
        },
    )]
}
