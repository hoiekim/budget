//! `POST /section`: `src/server/routes/budgets/post-section.ts`.

use crate::common::SECTION_NAME_REQUIRED_MESSAGE;
use crate::js::{Json, Obj};
use crate::server::entity_routes::{make_update_entity_route, UpdateEntityOptions};
use crate::server::postgres::repositories::budgets::update_section;
use crate::server::route::{ApiResponse, Route};
use crate::server::validation::{js_trim, FieldSpec, FieldType};

/// Typed fields `update_section` writes (`models/section.rs`). `name` is not
/// nullable here even though the column is: the client's `BudgetFamily.name`
/// is a plain string, so a null name renders as a blank row wherever the name
/// is shown.
const SECTION_BODY_SPEC: &[FieldSpec] = &[
    FieldSpec::new("section_id", FieldType::Uuid),
    FieldSpec::new("name", FieldType::String).max_length(255),
    FieldSpec::new("roll_over", FieldType::Boolean).nullable(),
    FieldSpec::new("roll_over_start_date", FieldType::Date).nullable(),
    FieldSpec::new("capacities", FieldType::Array),
];

/// The empty-name guard is per-entity (each entity answers with its own
/// message), so it stays an extra check instead of a shared rule.
fn extra_checks(data: &Obj) -> Option<ApiResponse> {
    match data.get("name") {
        Some(Json::String(name)) if js_trim(name).is_empty() => Some(ApiResponse::failed(SECTION_NAME_REQUIRED_MESSAGE)),
        _ => None,
    }
}

pub fn routes() -> Vec<Route> {
    vec![make_update_entity_route(
        "/section",
        |user, id, data| Box::pin(update_section(user, id, data)),
        UpdateEntityOptions {
            id_field: "section_id",
            field_spec: SECTION_BODY_SPEC,
            entity_label: "section",
            id_log_key: "sectionId",
            extra_checks: Some(extra_checks),
        },
    )]
}
