//! `src/server/lib/postgres/repositories/budgets.ts`. Not ported yet.
//!
//! TEMPORARY: only `get_owned_label_ids` is here, a copy ported from
//! `budgets.ts` because `repositories/recurrings.rs` calls it. The port of
//! `budgets.ts` replaces this file.

use std::collections::HashSet;

use crate::filters;
use crate::js::Json;
use crate::server::postgres::database::SearchFilters;
use crate::server::postgres::models::base::str_of;
use crate::server::postgres::models::common::{BUDGET_ID, CATEGORY_ID, USER_ID};
use crate::server::postgres::models::{budget, category, MaskedUser};

/// The budget and category ids labels name.
#[derive(Clone, Debug, Default)]
pub struct LabelIds {
    pub budget_ids: Vec<String>,
    pub category_ids: Vec<String>,
}

/// The ids among a [`LabelIds`] that are the user's own.
#[derive(Clone, Debug, Default)]
pub struct OwnedLabelIds {
    pub budget_ids: HashSet<String>,
    pub category_ids: HashSet<String>,
}

/// Of the given budget and category ids, the ones the user owns: one query per
/// table, however many ids. Deleted ones count: deleting a budget leaves the
/// labels that name it in place. A label naming anything outside these points
/// at another user's row, or at nothing.
pub async fn get_owned_label_ids(user: &MaskedUser, ids: &LabelIds) -> anyhow::Result<OwnedLabelIds> {
    let in_filter = |column: &str, ids: &[String]| SearchFilters {
        in_filters: vec![(column.to_string(), ids.iter().map(|id| Json::String(id.clone())).collect())],
        exclude_deleted: Some(false),
        ..Default::default()
    };
    let budgets = async {
        if ids.budget_ids.is_empty() {
            return Ok(Vec::new());
        }
        budget::TABLE.query(filters! { USER_ID => user.user_id.as_str() }, in_filter(BUDGET_ID, &ids.budget_ids), None).await
    };
    let categories = async {
        if ids.category_ids.is_empty() {
            return Ok(Vec::new());
        }
        category::TABLE.query(filters! { USER_ID => user.user_id.as_str() }, in_filter(CATEGORY_ID, &ids.category_ids), None).await
    };
    let (budgets, categories) = futures::future::try_join(budgets, categories).await?;
    Ok(OwnedLabelIds {
        budget_ids: budgets.iter().map(|budget| str_of(budget, BUDGET_ID).to_string()).collect(),
        category_ids: categories.iter().map(|category| str_of(category, CATEGORY_ID).to_string()).collect(),
    })
}
