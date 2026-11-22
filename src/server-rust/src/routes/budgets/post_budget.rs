//! `POST /budget`: `src/server/routes/budgets/post-budget.ts`.

use crate::common::BUDGET_NAME_REQUIRED_MESSAGE;
use crate::js::{Json, Obj};
use crate::server::entity_routes::{make_update_entity_route, UpdateEntityOptions};
use crate::server::postgres::repositories::budgets::update_budget;
use crate::server::route::{ApiResponse, Route};
use crate::server::validation::{js_trim, FieldSpec, FieldType};

/// Typed fields `update_budget` writes (`models/budget.rs`). `name` is not
/// nullable here even though the column is: the client's `BudgetFamily.name`
/// is a plain string it trims unguarded, so a null name breaks every
/// transaction row it renders.
const BUDGET_BODY_SPEC: &[FieldSpec] = &[
    FieldSpec::new("budget_id", FieldType::Uuid),
    FieldSpec::new("name", FieldType::String).max_length(255),
    FieldSpec::new("iso_currency_code", FieldType::String).nullable().max_length(10),
    FieldSpec::new("roll_over", FieldType::Boolean).nullable(),
    FieldSpec::new("roll_over_start_date", FieldType::Date).nullable(),
    FieldSpec::new("capacities", FieldType::Array),
];

/// The empty-name guard is per-entity (each entity answers with its own
/// message), so it stays an extra check instead of a shared rule.
fn extra_checks(data: &Obj) -> Option<ApiResponse> {
    match data.get("name") {
        Some(Json::String(name)) if js_trim(name).is_empty() => Some(ApiResponse::failed(BUDGET_NAME_REQUIRED_MESSAGE)),
        _ => None,
    }
}

pub fn routes() -> Vec<Route> {
    vec![make_update_entity_route(
        "/budget",
        |user, id, data| Box::pin(update_budget(user, id, data)),
        UpdateEntityOptions {
            id_field: "budget_id",
            field_spec: BUDGET_BODY_SPEC,
            entity_label: "budget",
            id_log_key: "budgetId",
            extra_checks: Some(extra_checks),
        },
    )]
}
