//! The cases of `src/server/lib/postgres/models/base.test.ts` that run
//! without a database: the ones whose `Table` method takes the executor to
//! query through. Its `Table.queryInBatches` cases are not here, because
//! `query_in_batches` always reads from the pool.

use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::json;

use super::base::Table;
use super::js_object::testing::obj;
use crate::js::{Json, Obj};
use crate::server::postgres::client::{Executor, QueryResult};

/// An executor that records each statement and answers it with no rows, as
/// the TypeScript tests' `createFakeSql` stub does.
#[derive(Default)]
pub(super) struct FakeExecutor {
    calls: Mutex<Vec<(String, Vec<Json>)>>,
}

impl FakeExecutor {
    /// Every `(sql, values)` queried so far.
    pub(super) fn calls(&self) -> Vec<(String, Vec<Json>)> {
        self.calls.lock().unwrap().clone()
    }

    /// The SQL of the one statement queried.
    fn emitted_sql(&self) -> String {
        let calls = self.calls();
        assert_eq!(calls.len(), 1, "expected one statement, got {calls:?}");
        calls[0].0.clone()
    }
}

#[async_trait]
impl Executor for FakeExecutor {
    async fn query(&self, text: &str, values: &[Json]) -> anyhow::Result<QueryResult> {
        self.calls.lock().unwrap().push((text.to_string(), values.to_vec()));
        Ok(QueryResult { rows: Vec::new(), row_count: Some(1) })
    }
}

static WIDGETS: Table = Table {
    name: "widgets",
    primary_key: "widget_id",
    schema: &[
        ("widget_id", "VARCHAR(255) PRIMARY KEY"),
        ("user_id", "VARCHAR(255)"),
        ("label", "VARCHAR(255)"),
        ("note", "VARCHAR(255)"),
    ],
    constraints: &[],
    indexes: &[],
    model: "WidgetModel",
    checks: &[],
    supports_soft_delete: true,
};

/// `updateColumnsOf` of `scripts/test-helpers.ts`: the columns an upsert's
/// `DO UPDATE SET` rewrites.
fn update_columns_of(sql: &str) -> Vec<String> {
    let Some(clause) = sql.split("DO UPDATE SET").nth(1) else { return Vec::new() };
    clause
        .split(',')
        .map(|part| part.trim().split('=').next().unwrap_or("").trim().to_string())
        .filter(|column| !column.is_empty())
        .collect()
}

async fn upsert(data: Json, update_columns: Option<&[&str]>) -> String {
    let executor = FakeExecutor::default();
    WIDGETS.upsert(&obj(data), update_columns, Some(&executor), None).await.unwrap();
    executor.emitted_sql()
}

// "Table.upsert conflict clause"

#[tokio::test]
async fn with_no_allowlist_every_supplied_column_is_rewritten_including_the_owner() {
    let columns = update_columns_of(&upsert(json!({ "widget_id": "w-1", "user_id": "u-1", "label": "a" }), None).await);
    assert!(columns.contains(&"user_id".to_string()));
    assert!(columns.contains(&"label".to_string()));
    // The primary key is the conflict target and is never in the SET list.
    assert!(!columns.contains(&"widget_id".to_string()));
}

#[tokio::test]
async fn an_allowlist_narrows_the_set_list_to_exactly_its_members() {
    let sql = upsert(json!({ "widget_id": "w-1", "user_id": "u-1", "label": "a" }), Some(&["label"])).await;
    let columns = update_columns_of(&sql);
    assert!(columns.contains(&"label".to_string()));
    assert!(!columns.contains(&"user_id".to_string()));
}

#[tokio::test]
async fn an_empty_allowlist_means_do_nothing_not_do_update() {
    let sql = upsert(json!({ "widget_id": "w-1", "user_id": "u-1" }), Some(&[])).await;
    assert!(sql.contains("DO NOTHING"));
    assert!(!sql.contains("DO UPDATE SET"));
}

#[tokio::test]
async fn an_undefined_value_is_dropped_from_the_set_list_as_well_as_the_insert() {
    // The two clauses have to agree: a column the INSERT leaves out resolves
    // `EXCLUDED` to the column default, and a SET entry for it would overwrite
    // the stored value with that. `note` is undefined here: the key is absent.
    let sql = upsert(json!({ "widget_id": "w-1", "label": "a" }), None).await;
    assert!(!sql.split("DO UPDATE SET").next().unwrap().contains("note"));
    assert!(!update_columns_of(&sql).contains(&"note".to_string()));
    assert!(update_columns_of(&sql).contains(&"label".to_string()));
}

#[tokio::test]
async fn an_allowlist_member_whose_value_is_undefined_is_dropped_too() {
    let sql = upsert(json!({ "widget_id": "w-1", "label": "a" }), Some(&["label", "note"])).await;
    let columns = update_columns_of(&sql);
    assert!(columns.contains(&"label".to_string()));
    assert!(!columns.contains(&"note".to_string()));
}

#[tokio::test]
async fn an_explicit_null_is_a_value_so_it_still_overwrites() {
    let sql = upsert(json!({ "widget_id": "w-1", "label": "a", "note": null }), None).await;
    assert!(update_columns_of(&sql).contains(&"note".to_string()));
}

#[tokio::test]
async fn the_primary_key_is_the_conflict_target_unless_other_conflict_columns_are_given() {
    let sql = upsert(json!({ "widget_id": "w-1", "label": "a" }), Some(&["label"])).await;
    assert!(sql.contains(" ON CONFLICT (widget_id) DO UPDATE SET "), "{sql}");

    let executor = FakeExecutor::default();
    let data = obj(json!({ "user_id": "u-1", "label": "a", "note": "n" }));
    WIDGETS.upsert(&data, Some(&["user_id", "label", "note"]), Some(&executor), Some(&["user_id", "label"])).await.unwrap();
    let sql = executor.emitted_sql();
    assert!(sql.contains(" ON CONFLICT (user_id, label) DO UPDATE SET "), "{sql}");
    // A conflict column names the row, so it is never in the SET list.
    assert_eq!(update_columns_of(&sql), ["note", "updated"]);
}

// "Table.upsertMany"

async fn upsert_many(rows: Vec<Json>) -> Vec<(String, Vec<Json>)> {
    let executor = FakeExecutor::default();
    let rows: Vec<Obj> = rows.into_iter().map(obj).collect();
    WIDGETS.upsert_many(&rows, None, Some(&executor)).await.unwrap();
    executor.calls()
}

#[tokio::test]
async fn a_repeated_primary_key_collapses_to_one_tuple_last_write_winning() {
    // Postgres rejects a statement whose `ON CONFLICT DO UPDATE` would touch the
    // same row twice (21000), so a caller handing over two rows for one id has
    // to arrive as a single tuple, not two.
    let calls =
        upsert_many(vec![json!({ "widget_id": "w-1", "label": "first" }), json!({ "widget_id": "w-1", "label": "second" })]).await;
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].1, vec![json!("w-1"), json!("second")]);
}

#[tokio::test]
async fn rows_are_grouped_by_defined_column_set_one_statement_per_group() {
    // A column present in one row and absent from another would insert as its
    // default and then be propagated by `EXCLUDED.col` over the stored value.
    let calls =
        upsert_many(vec![json!({ "widget_id": "w-1", "label": "a", "note": "keep" }), json!({ "widget_id": "w-2", "label": "b" })]).await;
    assert_eq!(calls.len(), 2);

    let (with_note, without_note) = (&calls[0], &calls[1]);
    assert!(update_columns_of(&with_note.0).contains(&"note".to_string()));
    assert!(update_columns_of(&with_note.0).contains(&"label".to_string()));
    assert_eq!(with_note.1, vec![json!("w-1"), json!("a"), json!("keep")]);

    assert!(!without_note.0.contains("note"));
    assert!(update_columns_of(&without_note.0).contains(&"label".to_string()));
    assert_eq!(without_note.1, vec![json!("w-2"), json!("b")]);
}
