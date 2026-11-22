//! Mirrors a transaction's category change into the `rejected_categories`
//! event log: `src/server/lib/record-category-rejection.ts`.

use serde_json::json;

use crate::js::{Json, Obj};
use crate::server::postgres::client::{pool, Executor};
use crate::server::postgres::database::shared_with_sql;
use crate::server::postgres::models::MaskedUser;
use crate::server::postgres::repositories::rejected_categories::{add_rejected_category, remove_rejected_category};

/// A transaction's label before an update.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PrevLabel {
    pub category_id: Option<String>,
    pub budget_id: Option<String>,
    /// `transactions.label_category_confidence`. Drives the suggested-vs-confirmed
    /// distinction the disambiguation logic needs to tell a genuine rejection
    /// from a client side effect. `1` = user-confirmed; `(0, 1)` = engine-suggested;
    /// `None`/`0` = no label / cleared.
    pub category_confidence: Option<f64>,
}

fn was_suggested(prev: &PrevLabel) -> bool {
    prev.category_confidence.is_some_and(|confidence| confidence > 0.0 && confidence < 1.0)
}

/// What a category change records: the category it rejects, and the one
/// whose earlier rejection it clears.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RejectionChanges {
    pub reject: Option<String>,
    pub clear: Option<String>,
}

/// The rules of [`record_category_rejection`], without the writes.
pub fn rejection_changes(req_label: Option<&Json>, prev_label: &PrevLabel) -> RejectionChanges {
    let Some(Json::Object(req_label)) = req_label else { return RejectionChanges::default() };
    let Some(new_category_id) = req_label.get("category_id") else { return RejectionChanges::default() };

    let reject = match &prev_label.category_id {
        Some(prev_category_id)
            if !prev_category_id.is_empty()
                && new_category_id.as_str() != Some(prev_category_id.as_str())
                && was_suggested(prev_label) =>
        {
            Some(prev_category_id.clone())
        }
        _ => None,
    };
    let clear = new_category_id.as_str().map(str::to_string);
    RejectionChanges { reject, clear }
}

/// Mirrors a `transactions.label` update into the `rejected_categories`
/// event log. Called from the `POST /transaction` route AFTER the
/// `transactions.label_*` columns have been updated.
///
/// Rules:
///  - **The body does not include `label.category_id`**: no category change;
///    nothing to record. (Budget-only, memo-only, etc.)
///  - **The previous label was a SUGGESTION** (`0 < category_confidence < 1`)
///    AND the new category differs from it: record a rejection of the
///    previous category. Clearing or replacing a *confirmed* label is not a
///    rejection: the user is re-categorizing, not signaling the prior choice
///    was wrong.
///  - **The new category is a string** (not null): clear any prior rejection
///    of THAT category (the changed-my-mind cycle).
///
/// The caller does not let an error here fail the request: the label update
/// already succeeded, and a failure to mirror is a downgraded signal.
pub async fn record_category_rejection(
    user: &MaskedUser,
    transaction_id: &str,
    req_label: Option<&Json>,
    prev_label: &PrevLabel,
) -> anyhow::Result<()> {
    let changes = rejection_changes(req_label, prev_label);
    if let Some(category_id) = &changes.reject {
        add_rejected_category(user, transaction_id, category_id).await?;
    }
    if let Some(category_id) = &changes.clear {
        remove_rejected_category(user, transaction_id, category_id).await?;
    }
    Ok(())
}

fn get_prev_label_sql() -> String {
    format!(
        "SELECT label_category_id, label_budget_id, label_category_confidence
     FROM transactions
     WHERE transaction_id = $1 AND {}
       AND (is_deleted IS NULL OR is_deleted = FALSE)
     LIMIT 1",
        shared_with_sql("user_id", "$2")
    )
}

fn prev_label_of(row: Option<&Obj>) -> PrevLabel {
    let text = |column: &str| row.and_then(|row| row.get(column)).and_then(|value| value.as_str()).map(str::to_string);
    PrevLabel {
        category_id: text("label_category_id"),
        budget_id: text("label_budget_id"),
        category_confidence: row.and_then(|row| row.get("label_category_confidence")).and_then(|value| value.as_f64()),
    }
}

/// Reads the current `label.{category_id, budget_id, category_confidence}`
/// of a transaction. The route awaits this serially *before* the primary
/// update: running the read in parallel races against the overwrite, and the
/// mirror could see post-update state.
///
/// Every field is `None` when the transaction doesn't exist, is not within
/// the user's sharing group, or the column is unset.
pub async fn get_prev_label(user: &MaskedUser, transaction_id: &str) -> anyhow::Result<PrevLabel> {
    get_prev_label_on(pool(), user, transaction_id).await
}

async fn get_prev_label_on(executor: &dyn Executor, user: &MaskedUser, transaction_id: &str) -> anyhow::Result<PrevLabel> {
    // A targeted SELECT instead of reading the whole row: this runs on the
    // hot POST /transaction path. The owner scope makes a transaction outside
    // the user's sharing group read as "no row found" instead of leaking its
    // label.
    let result = executor.query(&get_prev_label_sql(), &[json!(transaction_id), json!(user.user_id)]).await?;
    Ok(prev_label_of(result.rows.first()))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;

    use super::*;
    use crate::server::postgres::client::QueryResult;

    fn user(user_id: &str) -> MaskedUser {
        MaskedUser { user_id: user_id.to_string(), username: "alice".to_string() }
    }

    /// Records each statement and answers the first with `rows`, the rest with nothing.
    #[derive(Default)]
    struct FakeExecutor {
        calls: Mutex<Vec<(String, Vec<Json>)>>,
        rows: Mutex<Option<Vec<Obj>>>,
    }

    impl FakeExecutor {
        fn new() -> Self {
            FakeExecutor::default()
        }

        fn respond(&self, rows: Vec<Json>) {
            *self.rows.lock().unwrap() = Some(rows.into_iter().filter_map(|row| row.as_object().cloned()).collect());
        }

        fn calls(&self) -> Vec<(String, Vec<Json>)> {
            self.calls.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl Executor for FakeExecutor {
        async fn query(&self, text: &str, values: &[Json]) -> anyhow::Result<QueryResult> {
            self.calls.lock().unwrap().push((text.to_string(), values.to_vec()));
            let rows = self.rows.lock().unwrap().take().unwrap_or_default();
            let row_count = rows.len() as u64;
            Ok(QueryResult { rows, row_count: Some(row_count) })
        }
    }

    fn prev(category_id: Option<&str>, category_confidence: Option<f64>) -> PrevLabel {
        PrevLabel { category_id: category_id.map(str::to_string), budget_id: None, category_confidence }
    }

    fn changes(req_label: Option<Json>, prev_label: &PrevLabel) -> RejectionChanges {
        rejection_changes(req_label.as_ref(), prev_label)
    }

    fn change(reject: Option<&str>, clear: Option<&str>) -> RejectionChanges {
        RejectionChanges { reject: reject.map(str::to_string), clear: clear.map(str::to_string) }
    }

    // "body shape gating"

    #[test]
    fn no_category_in_the_request_records_nothing() {
        assert_eq!(changes(Some(json!({ "memo": "groceries" })), &prev(Some("cat-A"), Some(1.0))), change(None, None));
        assert_eq!(changes(None, &prev(Some("cat-A"), Some(1.0))), change(None, None));
    }

    // "rejection happens ONLY when prev was a SUGGESTION"

    #[test]
    fn clearing_a_suggestion_rejects_it_and_clearing_a_confirmation_does_not() {
        assert_eq!(changes(Some(json!({ "category_id": null })), &prev(Some("cat-A"), Some(0.7))), change(Some("cat-A"), None));
        assert_eq!(changes(Some(json!({ "category_id": null })), &prev(Some("cat-A"), Some(1.0))), change(None, None));
    }

    #[test]
    fn picking_another_category_rejects_only_a_suggestion_and_always_clears_the_new_one() {
        assert_eq!(changes(Some(json!({ "category_id": "cat-B" })), &prev(Some("cat-A"), Some(0.7))), change(Some("cat-A"), Some("cat-B")));
        assert_eq!(changes(Some(json!({ "category_id": "cat-B" })), &prev(Some("cat-A"), Some(1.0))), change(None, Some("cat-B")));
    }

    #[test]
    fn a_budget_switch_follows_the_same_rule() {
        let label = json!({ "budget_id": "budget-B", "category_id": null });
        assert_eq!(changes(Some(label.clone()), &prev(Some("cat-A"), Some(1.0))), change(None, None));
        assert_eq!(changes(Some(label), &prev(Some("cat-X"), Some(0.7))), change(Some("cat-X"), None));
    }

    #[test]
    fn picking_the_same_category_rejects_nothing_and_clears_it() {
        assert_eq!(changes(Some(json!({ "category_id": "cat-A" })), &prev(Some("cat-A"), Some(0.7))), change(None, Some("cat-A")));
    }

    #[test]
    fn without_a_previous_category_there_is_nothing_to_reject() {
        assert_eq!(changes(Some(json!({ "category_id": null })), &prev(None, None)), change(None, None));
        assert_eq!(changes(Some(json!({ "category_id": "cat-A" })), &prev(None, None)), change(None, Some("cat-A")));
    }

    #[test]
    fn only_a_confidence_strictly_between_zero_and_one_is_a_suggestion() {
        let label = || Some(json!({ "category_id": null }));
        for confidence in [None, Some(0.0), Some(1.0), Some(-0.5), Some(1.5)] {
            assert_eq!(changes(label(), &prev(Some("cat-A"), confidence)), change(None, None));
        }
        for confidence in [0.01, 0.5, 0.99] {
            assert_eq!(changes(label(), &prev(Some("cat-A"), Some(confidence))), change(Some("cat-A"), None));
        }
    }

    #[test]
    fn a_category_that_is_not_a_string_clears_nothing() {
        assert_eq!(changes(Some(json!({ "category_id": 5 })), &prev(Some("cat-A"), Some(0.7))), change(Some("cat-A"), None));
    }

    // "getPrevLabel"

    #[tokio::test]
    async fn the_previous_label_is_read_within_the_sharing_group_and_live_rows_only() {
        let executor = FakeExecutor::new();
        executor.respond(vec![json!({
            "label_category_id": "cat-A",
            "label_budget_id": "bud-A",
            "label_category_confidence": 0.7,
        })]);
        let label = get_prev_label_on(&executor, &user("u-1"), "tx-1").await.unwrap();
        assert_eq!(
            label,
            PrevLabel { category_id: Some("cat-A".into()), budget_id: Some("bud-A".into()), category_confidence: Some(0.7) }
        );
        let calls = executor.calls();
        assert_eq!(calls.len(), 1);
        let sql = calls[0].0.split_whitespace().collect::<Vec<_>>().join(" ");
        assert_eq!(
            sql,
            "SELECT label_category_id, label_budget_id, label_category_confidence FROM transactions WHERE transaction_id = $1 AND user_id = ANY(sharing_user_ids($2)) AND (is_deleted IS NULL OR is_deleted = FALSE) LIMIT 1"
        );
        assert_eq!(calls[0].1, vec![json!("tx-1"), json!("u-1")]);
    }

    #[tokio::test]
    async fn a_missing_row_reads_as_no_label() {
        let executor = FakeExecutor::new();
        assert_eq!(get_prev_label_on(&executor, &user("u-1"), "tx-1").await.unwrap(), PrevLabel::default());
    }
}
