//! `src/server/lib/postgres/repositories/budgets.ts`.

use std::collections::HashSet;

use serde_json::json;

use crate::filters;
use crate::server::postgres::database::shared_with;
use crate::js::{truthy, Json, Obj};
use crate::server::postgres::client::{with_transaction, Executor};
use crate::server::postgres::database::{Filters, SearchFilters};
use crate::server::postgres::models::base::{str_of, value_of};
use crate::server::postgres::models::{budget, category, section, MaskedUser, Row, Table, UpdateArgs};

/// `value || fallback`.
fn or(value: Option<&Json>, fallback: Json) -> Json {
    match value {
        Some(value) if truthy(value) => value.clone(),
        _ => fallback,
    }
}

/// The user's live rows of `table`, narrowed to one `parent` when it is given and not empty.
async fn query_owned(table: &Table, user: &MaskedUser, parent: Option<(&str, &str)>) -> anyhow::Result<Vec<Row>> {
    let mut filters: Filters = filters! { "user_id" => shared_with(user) };
    if let Some((column, id)) = parent.filter(|(_, id)| !id.is_empty()) {
        filters.extend(filters! { column => id });
    }
    table.query(filters, SearchFilters::default(), None).await
}

/// The fields a partial update writes, in the order the statement names them.
/// A key the caller left out is left alone; `null` is written.
fn updates_of(data: &Obj, fields: &[&str]) -> Obj {
    let mut updates = Obj::new();
    for field in fields {
        if let Some(value) = data.get(*field) {
            updates.insert(field.to_string(), value.clone());
        }
    }
    updates
}

/// Updates one of the user's live rows by primary key; `false` when `data`
/// names no field or no such row exists.
async fn update_owned(table: &Table, user: &MaskedUser, id: &str, updates: Obj) -> anyhow::Result<bool> {
    if updates.is_empty() {
        return Ok(false);
    }
    let model = table.update(&json!(id), &updates, UpdateArgs { user_id: Some(shared_with(user)), ..Default::default() }).await?;
    Ok(model.is_some())
}

pub async fn search_budgets(user: &MaskedUser, budget_id: Option<&str>) -> anyhow::Result<Vec<Json>> {
    let models = query_owned(&budget::TABLE, user, budget_id.map(|id| ("budget_id", id))).await?;
    Ok(models.iter().map(budget::to_json).collect())
}

pub async fn create_budget(user: &MaskedUser, data: &Obj) -> anyhow::Result<Option<Json>> {
    let mut budget = Obj::new();
    budget.insert("name".into(), or(data.get("name"), json!("New Budget")));
    budget.insert("iso_currency_code".into(), or(data.get("iso_currency_code"), json!("USD")));
    budget.insert("roll_over".into(), or(data.get("roll_over"), json!(false)));
    if let Some(start_date) = data.get("roll_over_start_date") {
        budget.insert("roll_over_start_date".into(), start_date.clone());
    }
    budget.insert("capacities".into(), or(data.get("capacities"), json!([])));
    let row = budget::from_json(&budget, &user.user_id);
    let Some(result) = budget::TABLE.insert(&row, Some(&["*"]), false).await? else { return Ok(None) };
    let model = budget::TABLE.validate(result)?;
    Ok(Some(budget::to_json(&model)))
}

pub async fn update_budget(user: &MaskedUser, budget_id: &str, data: &Obj) -> anyhow::Result<bool> {
    // The JSONB column takes `capacities` as the array it is, not as text.
    let updates = updates_of(data, &["name", "iso_currency_code", "roll_over", "roll_over_start_date", "capacities"]);
    update_owned(&budget::TABLE, user, budget_id, updates).await
}

pub async fn delete_budget(user: &MaskedUser, budget_id: &str) -> anyhow::Result<bool> {
    let sections = section::TABLE
        .query(filters! { "user_id" => shared_with(user), "budget_id" => budget_id }, SearchFilters::default(), None)
        .await?;
    let section_ids: Vec<Json> = sections.iter().map(|section| value_of(section, "section_id")).collect();
    let owner = shared_with(user);
    let budget_id = budget_id.to_string();

    with_transaction(move |client| {
        Box::pin(async move {
            let client: &dyn Executor = client;
            for section_id in &section_ids {
                category::TABLE.bulk_soft_delete_by_column("section_id", section_id, Some(owner.clone()), Some(client)).await?;
            }

            if !section_ids.is_empty() {
                section::TABLE.bulk_soft_delete(&section_ids, &[("user_id", owner.clone())], Some(client)).await?;
            }

            let deleted = budget::TABLE.bulk_soft_delete(&[json!(budget_id)], &[("user_id", owner.clone())], Some(client)).await?;
            Ok(deleted > 0)
        })
    })
    .await
}

/// The budget and category ids a user owns, out of the ones asked about.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OwnedLabelIds {
    pub budget_ids: HashSet<String>,
    pub category_ids: HashSet<String>,
}

/// The user's rows of `table` among `ids`, deleted ones included, as their primary keys.
async fn owned_ids(table: &'static Table, user: &MaskedUser, ids: &[String]) -> anyhow::Result<HashSet<String>> {
    if ids.is_empty() {
        return Ok(HashSet::new());
    }
    let options = SearchFilters {
        in_filters: vec![(table.primary_key.to_string(), ids.iter().map(|id| json!(id)).collect())],
        exclude_deleted: Some(false),
        ..Default::default()
    };
    let rows = table.query(filters! { "user_id" => shared_with(user) }, options, None).await?;
    Ok(rows.iter().map(|row| str_of(row, table.primary_key).to_string()).collect())
}

/// Of the given budget and category ids, the ones the user owns: one query per
/// table, however many ids. Deleted ones count: deleting a budget leaves the
/// labels that name it in place. A label naming anything outside these points
/// at another user's row, or at nothing.
pub async fn get_owned_label_ids(user: &MaskedUser, budget_ids: &[String], category_ids: &[String]) -> anyhow::Result<OwnedLabelIds> {
    let (budget_ids, category_ids) =
        futures::try_join!(owned_ids(&budget::TABLE, user, budget_ids), owned_ids(&category::TABLE, user, category_ids))?;
    Ok(OwnedLabelIds { budget_ids, category_ids })
}

pub async fn get_sections(user: &MaskedUser, budget_id: Option<&str>) -> anyhow::Result<Vec<Json>> {
    let models = query_owned(&section::TABLE, user, budget_id.map(|id| ("budget_id", id))).await?;
    Ok(models.iter().map(section::to_json).collect())
}

pub async fn create_section(user: &MaskedUser, data: &Obj) -> anyhow::Result<Option<Json>> {
    // The foreign key proves only that the budget exists; it has to be the caller's. A budget that
    // isn't theirs gets the same answer as one that doesn't exist, so the answer reveals neither.
    let Some(budget_id) = data.get("budget_id").filter(|id| truthy(id)) else { return Ok(None) };
    let Some(budget) = budget::TABLE.query_one(filters! { "budget_id" => budget_id.clone(), "user_id" => shared_with(user) }).await?
    else {
        return Ok(None);
    };
    let mut section = Obj::new();
    section.insert("budget_id".into(), budget_id.clone());
    section.insert("name".into(), or(data.get("name"), json!("New Section")));
    section.insert("roll_over".into(), or(data.get("roll_over"), json!(false)));
    if let Some(start_date) = data.get("roll_over_start_date") {
        section.insert("roll_over_start_date".into(), start_date.clone());
    }
    section.insert("capacities".into(), or(data.get("capacities"), json!([])));
    // A section takes its budget's owner, so it leaves a sharing group with the budget.
    let row = section::from_json(&section, str_of(&budget, "user_id"));
    let Some(result) = section::TABLE.insert(&row, Some(&["*"]), false).await? else { return Ok(None) };
    let model = section::TABLE.validate(result)?;
    Ok(Some(section::to_json(&model)))
}

pub async fn update_section(user: &MaskedUser, section_id: &str, data: &Obj) -> anyhow::Result<bool> {
    // The JSONB column takes `capacities` as the array it is, not as text.
    let updates = updates_of(data, &["name", "roll_over", "roll_over_start_date", "capacities"]);
    update_owned(&section::TABLE, user, section_id, updates).await
}

pub async fn delete_section(user: &MaskedUser, section_id: &str) -> anyhow::Result<bool> {
    let owner = shared_with(user);
    let section_id = section_id.to_string();
    with_transaction(move |client| {
        Box::pin(async move {
            let client: &dyn Executor = client;
            category::TABLE.bulk_soft_delete_by_column("section_id", &json!(section_id), Some(owner.clone()), Some(client)).await?;
            let deleted = section::TABLE.bulk_soft_delete(&[json!(section_id)], &[("user_id", owner.clone())], Some(client)).await?;
            Ok(deleted > 0)
        })
    })
    .await
}

pub async fn get_categories(user: &MaskedUser, section_id: Option<&str>) -> anyhow::Result<Vec<Json>> {
    let models = query_owned(&category::TABLE, user, section_id.map(|id| ("section_id", id))).await?;
    Ok(models.iter().map(category::to_json).collect())
}

pub async fn create_category(user: &MaskedUser, data: &Obj) -> anyhow::Result<Option<Json>> {
    // As for a section's budget: the section has to be the caller's own.
    let Some(section_id) = data.get("section_id").filter(|id| truthy(id)) else { return Ok(None) };
    let Some(section) = section::TABLE.query_one(filters! { "section_id" => section_id.clone(), "user_id" => shared_with(user) }).await?
    else {
        return Ok(None);
    };
    let mut category = Obj::new();
    category.insert("section_id".into(), section_id.clone());
    category.insert("name".into(), or(data.get("name"), json!("New Category")));
    category.insert("roll_over".into(), or(data.get("roll_over"), json!(false)));
    if let Some(start_date) = data.get("roll_over_start_date") {
        category.insert("roll_over_start_date".into(), start_date.clone());
    }
    category.insert("capacities".into(), or(data.get("capacities"), json!([])));
    // A category takes its section's owner, so it leaves a sharing group with the section.
    let row = category::from_json(&category, str_of(&section, "user_id"));
    let Some(result) = category::TABLE.insert(&row, Some(&["*"]), false).await? else { return Ok(None) };
    let model = category::TABLE.validate(result)?;
    Ok(Some(category::to_json(&model)))
}

pub async fn update_category(user: &MaskedUser, category_id: &str, data: &Obj) -> anyhow::Result<bool> {
    // The JSONB column takes `capacities` as the array it is, not as text.
    let updates = updates_of(data, &["name", "roll_over", "roll_over_start_date", "capacities"]);
    update_owned(&category::TABLE, user, category_id, updates).await
}

pub async fn delete_category(user: &MaskedUser, category_id: &str) -> anyhow::Result<bool> {
    category::TABLE.soft_delete(&json!(category_id), Some(shared_with(user))).await
}
