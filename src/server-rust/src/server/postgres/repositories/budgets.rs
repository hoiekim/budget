//! `src/server/lib/postgres/repositories/budgets.ts`. Not ported yet.
//!
//! TEMPORARY: `get_owned_label_ids` alone is here, copied ahead of the port
//! of this file because `repositories/transactions.rs` calls it. The port of
//! `budgets.ts` replaces this file whole.

use std::collections::HashSet;

use serde_json::json;

use crate::filters;
use crate::js::Json;
use crate::server::postgres::database::SearchFilters;
use crate::server::postgres::models::base::str_of;
use crate::server::postgres::models::{budget, category, MaskedUser, Row};

/// The budget and category ids a set of labels names.
#[derive(Clone, Debug, Default)]
pub struct LabelIds {
    pub budget_ids: Vec<String>,
    pub category_ids: Vec<String>,
}

/// The budget and category ids a user owns, of the ones asked about.
#[derive(Clone, Debug, Default)]
pub struct OwnedLabelIds {
    pub budget_ids: HashSet<String>,
    pub category_ids: HashSet<String>,
}

fn in_filter(column: &str, ids: &[String]) -> SearchFilters {
    SearchFilters {
        in_filters: vec![(column.to_string(), ids.iter().map(|id| json!(id)).collect::<Vec<Json>>())],
        exclude_deleted: Some(false),
        ..Default::default()
    }
}

/// Of the given budget and category ids, the ones the user owns: one query per
/// table, however many ids. Deleted ones count: deleting a budget leaves the
/// labels that name it in place. A label naming anything outside these points
/// at another user's row, or at nothing.
pub async fn get_owned_label_ids(user: &MaskedUser, ids: &LabelIds) -> anyhow::Result<OwnedLabelIds> {
    let budgets = async {
        if ids.budget_ids.is_empty() {
            return Ok(Vec::<Row>::new());
        }
        budget::TABLE.query(filters! { "user_id" => user.user_id.as_str() }, in_filter("budget_id", &ids.budget_ids), None).await
    };
    let categories = async {
        if ids.category_ids.is_empty() {
            return Ok(Vec::<Row>::new());
        }
        category::TABLE
            .query(filters! { "user_id" => user.user_id.as_str() }, in_filter("category_id", &ids.category_ids), None)
            .await
    };
    // Both lookups are issued and run to their end, as under `Promise.all`,
    // whether or not the other fails.
    let (budgets, categories) = futures::join!(budgets, categories);
    Ok(OwnedLabelIds {
        budget_ids: budgets?.iter().map(|b| str_of(b, "budget_id").to_string()).collect(),
        category_ids: categories?.iter().map(|c| str_of(c, "category_id").to_string()).collect(),
    })
}
