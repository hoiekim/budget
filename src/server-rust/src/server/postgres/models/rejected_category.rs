//! `src/server/lib/postgres/models/rejected-category.ts`.
//!
//! Stores every (transaction, category) pair the user has explicitly
//! rejected. Read by the auto-suggest engine's merchant signal to downweight
//! categories the user keeps saying no to.
//!
//! Composite PRIMARY KEY on `(transaction_id, category_id)`: at most one row
//! per pair. Other tables only carry the current state; this table exists
//! *because* the denormalized columns can't carry rejection history
//! (`transactions.label_category_id` is a single current label, not a
//! sequence). Confirmations and the engine's ephemeral scores live elsewhere
//! (`transactions.label_category_id` + `label_category_confidence`).

use super::base::{Check, IndexDefinition, Row, Table};
use super::js_object::Literal;
use crate::js::Json;

pub static TABLE: Table = Table {
    name: "rejected_categories",
    // Composite primary key; `Table` requires a single-column `primary_key`
    // for its built-in CRUD helpers, none of which the rejected-categories
    // repository uses (all writes go through raw SQL). The guard in those
    // helpers is an error for anyone who reaches for them on this table.
    primary_key: "transaction_id",
    schema: &[
        // transactions.transaction_id is VARCHAR(255). The FK keeps rejection
        // rows bound to a real transaction and cascades on transaction delete.
        ("transaction_id", "VARCHAR(255) REFERENCES transactions(transaction_id) ON DELETE CASCADE NOT NULL"),
        ("user_id", "UUID REFERENCES users(user_id) ON DELETE CASCADE NOT NULL"),
        // category_id is part of the composite PK, so it must be NOT NULL.
        ("category_id", "UUID REFERENCES categories(category_id) ON DELETE CASCADE NOT NULL"),
        ("rejected_at", "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP"),
    ],
    constraints: &["PRIMARY KEY (transaction_id, category_id)"],
    indexes: &[IndexDefinition::column("user_id")],
    model: "RejectedCategoryModel",
    checks: &[
        ("transaction_id", Check::String),
        ("user_id", Check::String),
        ("category_id", Check::String),
        ("rejected_at", Check::NullableString),
    ],
    supports_soft_delete: false,
};

/// `rejectedCategoryColumns`.
pub fn columns() -> Vec<&'static str> {
    TABLE.columns()
}

/// `toJSON()`: a `JSONRejectedCategory`.
pub fn to_json(row: &Row) -> Json {
    Literal::new()
        .opt("transaction_id", row.get("transaction_id"))
        .opt("category_id", row.get("category_id"))
        .opt("rejected_at", row.get("rejected_at"))
        .into()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::base::UpdateArgs;
    use super::super::base_test::FakeExecutor;
    use super::super::js_object::testing::{assert_json, obj};
    use super::*;
    use crate::js::Obj;
    use crate::server::postgres::database::SearchFilters;

    fn row() -> Json {
        json!({
            "transaction_id": "tx-1",
            "user_id": "0b6d4a2e-6f0c-4a52-9c1f-5d1f6f1f3a10",
            "category_id": "c2a4b1de-7c64-4b6e-9e0a-6a1d2c3b4e5f",
            "rejected_at": "2026-06-01T00:00:00.000Z",
        })
    }

    #[test]
    fn to_json_leaves_out_the_owner() {
        let row = TABLE.validate(obj(row())).unwrap();
        assert_json(
            &to_json(&row),
            json!({ "transaction_id": "tx-1", "category_id": "c2a4b1de-7c64-4b6e-9e0a-6a1d2c3b4e5f", "rejected_at": "2026-06-01T00:00:00.000Z" }),
        );
    }

    #[test]
    fn to_json_keeps_a_null_rejected_at_and_a_row_needs_the_key() {
        let mut row = obj(row());
        row.insert("rejected_at".into(), Json::Null);
        let validated = TABLE.validate(row.clone()).unwrap();
        assert_eq!(to_json(&validated).get("rejected_at"), Some(&Json::Null));

        row.shift_remove("rejected_at");
        let error = TABLE.validate(row).unwrap_err().to_string();
        assert_eq!(error, "RejectedCategoryModel validation failed:\nrejected_at: undefined (undefined)");
    }

    // `rejected-category.test.ts`, "rejectedCategoriesTable — composite-PK Table guards".
    //
    // The built-in single-PK helpers must fail for this table: composite
    // PRIMARY KEY (transaction_id, category_id) means `primary_key`
    // (= "transaction_id" alone) is not the row key. The guard catches misuse
    // before SQL goes out.

    fn data() -> Obj {
        obj(json!({ "transaction_id": "tx-1", "user_id": "u-1", "category_id": "cat-A" }))
    }

    fn assert_guarded<T>(result: anyhow::Result<T>, method: &str) {
        let Err(error) = result else { panic!("Table.{method}() went through") };
        assert_eq!(
            error.to_string(),
            format!(
                "Table.{method}() is not supported on 'rejected_categories' — composite PRIMARY KEY tables must use raw pool.query writes in their repository layer."
            )
        );
    }

    #[tokio::test]
    async fn insert_fails_must_use_raw_queries_in_the_repository() {
        assert_guarded(TABLE.insert(&data(), None, false).await, "insert");
    }

    #[tokio::test]
    async fn upsert_fails_the_obvious_wrong_helper_choice() {
        assert_guarded(TABLE.upsert(&data(), None, None, None).await, "upsert");
    }

    #[tokio::test]
    async fn hard_delete_fails_it_would_drop_every_row_of_a_transaction_not_one_pair() {
        assert_guarded(TABLE.hard_delete(&json!("tx-1")).await, "hardDelete");
    }

    #[tokio::test]
    async fn update_fails() {
        let update = obj(json!({ "rejected_at": "now" }));
        assert_guarded(TABLE.update(&json!("tx-1"), &update, UpdateArgs::default()).await, "update");
    }

    #[tokio::test]
    async fn query_by_ids_fails() {
        assert_guarded(TABLE.query_by_ids(&[json!("tx-1")], &[]).await, "queryByIds");
    }

    #[tokio::test]
    async fn hard_delete_by_column_fails() {
        assert_guarded(TABLE.hard_delete_by_column("transaction_id", &json!("tx-1")).await, "hardDeleteByColumn");
    }

    #[tokio::test]
    async fn delete_by_condition_fails_also_unsafe_on_a_composite_key() {
        assert_guarded(TABLE.delete_by_condition("rejected_at", "<", &json!("2025-01-01")).await, "deleteByCondition");
    }

    #[tokio::test]
    async fn query_the_filter_based_read_is_unaffected_it_does_not_use_the_primary_key() {
        let executor = FakeExecutor::default();
        let rows = TABLE.query(crate::filters! { "user_id" => "u-1" }, SearchFilters::default(), Some(&executor)).await.unwrap();
        assert!(rows.is_empty());
        // No soft-delete predicate either: the table has no `is_deleted`.
        assert_eq!(executor.calls(), vec![("SELECT * FROM rejected_categories WHERE user_id = $1".to_string(), vec![json!("u-1")])]);
    }

    // "rejectedCategoriesTable — schema invariants"

    #[test]
    fn constraint_list_includes_the_composite_pk() {
        assert!(TABLE.constraints.contains(&"PRIMARY KEY (transaction_id, category_id)"));
    }

    #[test]
    fn schema_is_minimal_only_the_four_columns_we_need() {
        let mut columns = columns();
        columns.sort();
        assert_eq!(columns, ["category_id", "rejected_at", "transaction_id", "user_id"]);
    }

    #[test]
    fn rejected_at_defaults_to_current_timestamp() {
        // So adding a rejection only needs to set the three NOT NULL columns.
        let definition = TABLE.schema.iter().find(|(column, _)| *column == "rejected_at").map(|(_, definition)| *definition);
        assert_eq!(definition, Some("TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP"));
    }
}
