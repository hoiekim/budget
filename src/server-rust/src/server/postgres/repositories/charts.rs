//! `src/server/lib/postgres/repositories/charts.ts`.

use serde_json::json;

use crate::filters;
use crate::server::postgres::database::shared_with;
use crate::js::{json_parse, truthy, Json, Obj};
use crate::server::postgres::database::{Filters, SearchFilters};
use crate::server::postgres::models::{chart, MaskedUser, UpdateArgs};

/// `ChartType.BALANCE` of `src/common/models/Chart.ts`: what a new chart is.
const BALANCE_CHART: &str = "balance_chart";

/// `value || fallback`.
fn or(value: Option<&Json>, fallback: Json) -> Json {
    match value {
        Some(value) if truthy(value) => value.clone(),
        _ => fallback,
    }
}

/// The value the JSONB column stores for a `configuration` as the client
/// sends it: JSON text is parsed, anything else is taken as it is. Text that
/// is not JSON is an error, where the TypeScript throws out of `JSON.parse`.
fn parse_configuration(configuration: &Json) -> anyhow::Result<Json> {
    match configuration {
        Json::String(text) => json_parse(text).ok_or_else(|| anyhow::anyhow!("The chart configuration is not valid JSON")),
        other => Ok(other.clone()),
    }
}

/// The user's live charts, narrowed to one id and/or one type when given and not empty.
pub async fn search_charts(user: &MaskedUser, chart_id: Option<&str>, chart_type: Option<&str>) -> anyhow::Result<Vec<Json>> {
    let mut filters: Filters = filters! { "user_id" => shared_with(user) };
    if let Some(chart_id) = chart_id.filter(|id| !id.is_empty()) {
        filters.extend(filters! { "chart_id" => chart_id });
    }
    if let Some(chart_type) = chart_type.filter(|chart_type| !chart_type.is_empty()) {
        filters.extend(filters! { "type" => chart_type });
    }

    let models = chart::TABLE.query(filters, SearchFilters::default(), None).await?;
    Ok(models.iter().map(chart::to_json).collect())
}

pub async fn create_chart(user: &MaskedUser, data: &Obj) -> anyhow::Result<Option<Json>> {
    // The client sends configuration as a JSON string; it is parsed to the
    // object the JSONB column stores. No configuration means an empty object.
    let config = match data.get("configuration").filter(|configuration| truthy(configuration)) {
        Some(configuration) => parse_configuration(configuration)?,
        None => json!({}),
    };

    let mut row = Obj::new();
    row.insert("user_id".into(), json!(user.user_id));
    row.insert("name".into(), or(data.get("name"), json!("New Chart")));
    row.insert("type".into(), or(data.get("type"), json!(BALANCE_CHART)));
    row.insert("configuration".into(), config);

    let Some(result) = chart::TABLE.insert(&row, Some(&["*"]), false).await? else { return Ok(None) };
    let model = chart::TABLE.validate(result)?;
    Ok(Some(chart::to_json(&model)))
}

pub async fn update_chart(user: &MaskedUser, chart_id: &str, data: &Obj) -> anyhow::Result<bool> {
    let mut updates = Obj::new();
    if let Some(name) = data.get("name") {
        updates.insert("name".into(), name.clone());
    }
    if let Some(chart_type) = data.get("type") {
        updates.insert("type".into(), chart_type.clone());
    }
    if let Some(configuration) = data.get("configuration") {
        updates.insert("configuration".into(), parse_configuration(configuration)?);
    }

    if updates.is_empty() {
        return Ok(false);
    }

    let model = chart::TABLE.update(&json!(chart_id), &updates, UpdateArgs { user_id: Some(shared_with(user)), ..Default::default() }).await?;
    Ok(model.is_some())
}

pub async fn delete_chart(user: &MaskedUser, chart_id: &str) -> anyhow::Result<bool> {
    chart::TABLE.soft_delete(&json!(chart_id), Some(shared_with(user))).await
}
