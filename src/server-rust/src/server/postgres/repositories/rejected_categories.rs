//! `src/server/lib/postgres/repositories/rejected-categories.ts`.

use serde_json::json;

use crate::filters;
use crate::js::Json;
use crate::server::postgres::client::{pool, Executor};
use crate::server::postgres::database::SearchFilters;
use crate::server::postgres::models::{rejected_category, MaskedUser};

/// Records a user's rejection of `category_id` for `transaction_id`. UPSERT
/// so a re-reject of the same pair just refreshes the timestamp.
///
/// The row belongs to the transaction's owner, whoever in their sharing group
/// rejected the category: the suggestion engine reads rejections per owner. A
/// transaction outside the group inserts nothing.
///
/// The owner check on the ON CONFLICT DO UPDATE branch is
/// defense-in-depth: transaction_id is globally unique today, but if a
/// future schema change ever lets two users share a transaction_id, this
/// guard prevents cross-user clobber.
pub async fn add_rejected_category(user: &MaskedUser, transaction_id: &str, category_id: &str) -> anyhow::Result<Option<Json>> {
    add_rejected_category_on(pool(), user, transaction_id, category_id).await
}

async fn add_rejected_category_on(
    executor: &dyn Executor,
    user: &MaskedUser,
    transaction_id: &str,
    category_id: &str,
) -> anyhow::Result<Option<Json>> {
    // Composite PRIMARY KEY (transaction_id, category_id): Table.upsert /
    // .update / .insert all assert a simple key and would fail. Carve-out.
    let sql = "
    INSERT INTO rejected_categories
      (transaction_id, user_id, category_id)
    SELECT t.transaction_id, t.user_id, $3
    FROM transactions t
    WHERE t.transaction_id = $1 AND t.user_id = ANY(sharing_user_ids($2))
    ON CONFLICT (transaction_id, category_id)
    DO UPDATE SET rejected_at = CURRENT_TIMESTAMP
      WHERE rejected_categories.user_id = EXCLUDED.user_id
    RETURNING *
  ";
    let result = executor.query(sql, &[json!(transaction_id), json!(user.user_id), json!(category_id)]).await?;
    match result.rows.into_iter().next() {
        Some(row) => Ok(Some(rejected_category::to_json(&rejected_category::TABLE.validate(row)?))),
        None => Ok(None),
    }
}

/// Clears a rejection row: used when the user later confirms the same
/// category they once rejected ("changed my mind").
pub async fn remove_rejected_category(user: &MaskedUser, transaction_id: &str, category_id: &str) -> anyhow::Result<u64> {
    remove_rejected_category_on(pool(), user, transaction_id, category_id).await
}

async fn remove_rejected_category_on(
    executor: &dyn Executor,
    user: &MaskedUser,
    transaction_id: &str,
    category_id: &str,
) -> anyhow::Result<u64> {
    // Composite PRIMARY KEY: Table.delete_by_condition (and the rest of the
    // simple-key helpers) assert a simple key and would fail. Carve-out.
    let sql = "
    DELETE FROM rejected_categories
    WHERE user_id = ANY(sharing_user_ids($1))
      AND transaction_id = $2
      AND category_id = $3
  ";
    let result = executor.query(sql, &[json!(user.user_id), json!(transaction_id), json!(category_id)]).await?;
    Ok(result.row_count.unwrap_or(0))
}

/// Migrates rejection rows from a pending Plaid transaction_id onto the
/// posted transaction_id that supersedes it.
///
/// When Plaid transitions a transaction from pending → posted, the
/// stored row keeps its OLD `transaction_id` (the pending id) and a NEW
/// row is created with the POSTED id. Any rejection rows the user
/// recorded while the transaction was pending stay attached to the OLD
/// id and become orphaned signal from the engine's point of view (it
/// scans by transaction_id matching the current merchant join).
///
/// This migrates them in-place: copy rows from `pending` → `posted` with
/// `ON CONFLICT DO NOTHING` (in case the posted id already has its own
/// rejection rows), then delete the original pending-side rows. Runs in
/// a single transaction so a partial failure can't leave both copies
/// present.
///
/// Returns the number of rows migrated.
pub async fn migrate_rejected_categories_on_pending_posted(
    pending_transaction_id: &str,
    posted_transaction_id: &str,
) -> anyhow::Result<u64> {
    // INSERT ... SELECT ... ON CONFLICT inside a transaction: outside
    // Table.upsert's surface (composite key + cross-row copy + DELETE).
    if pending_transaction_id == posted_transaction_id {
        return Ok(0);
    }
    let client = pool().connect().await?;
    migrate_rejected_categories_on(&client, pending_transaction_id, posted_transaction_id).await
}

/// The migration on a reserved connection: its own BEGIN … COMMIT, and a
/// ROLLBACK when any statement, the COMMIT included, fails. A ROLLBACK
/// that fails too is ignored; the first error is the one reported.
async fn migrate_rejected_categories_on(
    client: &dyn Executor,
    pending_transaction_id: &str,
    posted_transaction_id: &str,
) -> anyhow::Result<u64> {
    let migrated = async {
        client.query("BEGIN", &[]).await?;
        let copy_result = client
            .query(
                "
      INSERT INTO rejected_categories
        (transaction_id, user_id, category_id, rejected_at)
      SELECT $1, user_id, category_id, rejected_at
      FROM rejected_categories
      WHERE transaction_id = $2
      ON CONFLICT (transaction_id, category_id) DO NOTHING
      ",
                &[json!(posted_transaction_id), json!(pending_transaction_id)],
            )
            .await?;
        client.query("DELETE FROM rejected_categories WHERE transaction_id = $1", &[json!(pending_transaction_id)]).await?;
        client.query("COMMIT", &[]).await?;
        anyhow::Ok(copy_result.row_count.unwrap_or(0))
    };
    match migrated.await {
        Ok(count) => Ok(count),
        Err(error) => {
            let _ = client.query("ROLLBACK", &[]).await;
            Err(error)
        }
    }
}

/// Bulk read rejection rows across a set of transactions: used by
/// `get_merchant_signal` (Stage 2b) to count rejections per (merchant,
/// category).
pub async fn get_rejected_categories_for_transactions(user: &MaskedUser, transaction_ids: &[String]) -> anyhow::Result<Vec<Json>> {
    get_rejected_categories_for_transactions_on(pool(), user, transaction_ids).await
}

async fn get_rejected_categories_for_transactions_on(
    executor: &dyn Executor,
    user: &MaskedUser,
    transaction_ids: &[String],
) -> anyhow::Result<Vec<Json>> {
    if transaction_ids.is_empty() {
        return Ok(Vec::new());
    }
    let models = rejected_category::TABLE
        .query(
            filters! { "user_id" => user.user_id.as_str() },
            SearchFilters {
                in_filters: vec![("transaction_id".to_string(), transaction_ids.iter().map(|id| json!(id)).collect())],
                order_by: Some("transaction_id, rejected_at DESC".to_string()),
                ..Default::default()
            },
            Some(executor),
        )
        .await?;
    Ok(models.iter().map(rejected_category::to_json).collect())
}

#[cfg(test)]
mod tests {
    use regex::Regex;
    use serde_json::json;

    use super::super::transactions::testing::{obj, FakeExecutor};
    use super::*;
    use crate::js::json_stringify;

    fn fake_user() -> MaskedUser {
        MaskedUser { user_id: "u-1".to_string(), username: "alice".to_string() }
    }

    fn fake_row(overrides: Json) -> Json {
        let mut row = obj(json!({
            "transaction_id": "tx-1",
            "user_id": "u-1",
            "category_id": "cat-A",
            "rejected_at": "2026-06-09T13:00:00Z",
        }));
        row.extend(obj(overrides));
        Json::Object(row)
    }

    fn matches(pattern: &str, text: &str) -> bool {
        Regex::new(pattern).unwrap().is_match(text)
    }

    fn statements(executor: &FakeExecutor) -> Vec<String> {
        executor.calls().into_iter().map(|(sql, _)| sql).collect()
    }

    // These are SQL-shape checks against a scripted executor. They document
    // the contracts the helpers are designed to produce.

    // "addRejectedCategory [SQL-shape]"

    #[tokio::test]
    async fn add_is_a_composite_key_upsert_that_refreshes_rejected_at() {
        let executor = FakeExecutor::new().rows(vec![fake_row(json!({ "rejected_at": "now" }))]);
        let result = add_rejected_category_on(&executor, &fake_user(), "tx-1", "cat-A").await.unwrap().unwrap();
        let sql = executor.sql(0);
        assert!(matches(r"INSERT INTO rejected_categories", &sql));
        // The row is written under the transaction's owner, for a transaction the
        // user or someone sharing data with them owns.
        assert!(matches(
            r"\(\s*transaction_id,\s+user_id,\s+category_id\s*\)\s*SELECT\s+t\.transaction_id,\s+t\.user_id,\s+\$3\s+FROM transactions t\s+WHERE t\.transaction_id\s*=\s*\$1 AND t\.user_id = ANY\(sharing_user_ids\(\$2\)\)\s+ON CONFLICT",
            &sql
        ));
        assert!(matches(r"ON CONFLICT \(transaction_id,\s*category_id\)", &sql));
        assert!(matches(r"DO UPDATE SET\s+rejected_at\s*=\s*CURRENT_TIMESTAMP", &sql));
        assert!(matches(r"WHERE rejected_categories\.user_id\s*=\s*EXCLUDED\.user_id\s+RETURNING \*", &sql));
        assert_eq!(executor.values(0), vec![json!("tx-1"), json!("u-1"), json!("cat-A")]);
        assert_eq!(json_stringify(&result), r#"{"transaction_id":"tx-1","category_id":"cat-A","rejected_at":"now"}"#);
    }

    // `repository-pins.test.ts`, "rejected-categories edge semantics".
    #[tokio::test]
    async fn add_maps_an_empty_result_to_none() {
        let executor = FakeExecutor::new();
        assert!(add_rejected_category_on(&executor, &fake_user(), "t-1", "food").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn add_fails_on_a_row_the_model_does_not_accept() {
        let executor = FakeExecutor::new().rows(vec![json!({ "transaction_id": "tx-1", "user_id": "u-1", "category_id": "cat-A" })]);
        let error = add_rejected_category_on(&executor, &fake_user(), "tx-1", "cat-A").await.unwrap_err();
        assert_eq!(error.to_string(), "RejectedCategoryModel validation failed:\nrejected_at: undefined (undefined)");
    }

    // "removeRejectedCategory [SQL-shape]"

    #[tokio::test]
    async fn remove_deletes_scoped_on_user_transaction_and_category() {
        // Used when the user changes their mind.
        let executor = FakeExecutor::new().count(1);
        let n = remove_rejected_category_on(&executor, &fake_user(), "tx-1", "cat-A").await.unwrap();
        let sql = executor.sql(0);
        assert!(matches(r"DELETE FROM rejected_categories", &sql));
        assert!(matches(r"WHERE user_id = ANY\(sharing_user_ids\(\$1\)\)", &sql));
        assert!(matches(r"transaction_id\s*=\s*\$2", &sql));
        assert!(matches(r"category_id\s*=\s*\$3", &sql));
        assert_eq!(executor.values(0), vec![json!("u-1"), json!("tx-1"), json!("cat-A")]);
        assert_eq!(n, 1);
    }

    #[tokio::test]
    async fn remove_returns_0_when_no_row_matched() {
        let executor = FakeExecutor::new().count(0);
        assert_eq!(remove_rejected_category_on(&executor, &fake_user(), "tx-nope", "cat-nope").await.unwrap(), 0);
    }

    // "migrateRejectedCategoriesOnPendingPosted [SQL-shape]"

    // Guards against accidental no-op transitions; no connection is reserved.
    #[tokio::test]
    async fn migrate_is_a_no_op_when_pending_and_posted_ids_match() {
        assert_eq!(migrate_rejected_categories_on_pending_posted("tx-same", "tx-same").await.unwrap(), 0);
    }

    #[tokio::test]
    async fn migrate_wraps_begin_insert_with_conflict_delete_commit() {
        // 4 queries: BEGIN, INSERT, DELETE, COMMIT.
        let executor = FakeExecutor::new().count(0).count(3).count(3).count(0);
        let n = migrate_rejected_categories_on(&executor, "PENDING-1", "POSTED-1").await.unwrap();

        let sqls = statements(&executor);
        assert_eq!(sqls.len(), 4);
        assert_eq!(sqls[0], "BEGIN");
        assert!(matches(r"INSERT INTO rejected_categories", &sqls[1]));
        assert!(matches(r"SELECT\s+\$1,\s+user_id,\s+category_id,\s+rejected_at", &sqls[1]));
        assert!(matches(r"FROM rejected_categories\s+WHERE transaction_id\s*=\s*\$2", &sqls[1]));
        assert!(matches(r"ON CONFLICT \(transaction_id,\s*category_id\)\s+DO NOTHING", &sqls[1]));
        assert!(matches(r"DELETE FROM rejected_categories WHERE transaction_id\s*=\s*\$1", &sqls[2]));
        assert_eq!(sqls[3], "COMMIT");

        // INSERT values: ($1=posted, $2=pending)
        assert_eq!(executor.values(1), vec![json!("POSTED-1"), json!("PENDING-1")]);
        // DELETE values: ($1=pending)
        assert_eq!(executor.values(2), vec![json!("PENDING-1")]);

        assert_eq!(n, 3);
    }

    // No partial state left behind.
    #[tokio::test]
    async fn migrate_rolls_back_if_the_insert_fails() {
        let executor = FakeExecutor::new().count(0).failure("simulated INSERT failure").count(0);
        let error = migrate_rejected_categories_on(&executor, "PENDING-1", "POSTED-1").await.unwrap_err();
        assert!(error.to_string().contains("simulated INSERT failure"));
        let sqls = statements(&executor);
        assert_eq!(sqls[0], "BEGIN");
        assert_eq!(sqls[2], "ROLLBACK");
        assert_eq!(sqls.len(), 3);
    }

    // The multi-step guarantee.
    #[tokio::test]
    async fn migrate_rolls_back_if_the_delete_fails_after_a_successful_insert() {
        let executor = FakeExecutor::new().count(0).count(2).failure("simulated DELETE failure").count(0);
        let error = migrate_rejected_categories_on(&executor, "PENDING-1", "POSTED-1").await.unwrap_err();
        assert!(error.to_string().contains("simulated DELETE failure"));
        let sqls = statements(&executor);
        assert_eq!(sqls[0], "BEGIN");
        assert!(matches(r"INSERT INTO rejected_categories", &sqls[1]));
        assert_eq!(sqls[3], "ROLLBACK");
    }

    // A last-step failure can't leave an open transaction.
    #[tokio::test]
    async fn migrate_rolls_back_if_the_commit_itself_fails() {
        let executor = FakeExecutor::new().count(0).count(1).count(1).failure("simulated COMMIT failure").count(0);
        let error = migrate_rejected_categories_on(&executor, "PENDING-1", "POSTED-1").await.unwrap_err();
        assert!(error.to_string().contains("simulated COMMIT failure"));
        let sqls = statements(&executor);
        assert_eq!(sqls[0], "BEGIN");
        assert_eq!(sqls[3], "COMMIT");
        assert_eq!(sqls[4], "ROLLBACK");
    }

    // `repository-pins.test.ts`, "rejected-categories edge semantics".
    #[tokio::test]
    async fn migrate_swallows_a_rollback_failure_and_the_original_error_wins() {
        let executor = FakeExecutor::new().count(0).failure("insert failed").failure("rollback failed");
        let error = migrate_rejected_categories_on(&executor, "t-old", "t-new").await.unwrap_err();
        assert_eq!(error.to_string(), "insert failed");
        let sqls: Vec<String> = statements(&executor).iter().map(|sql| sql.trim().to_string()).collect();
        assert_eq!(sqls[0], "BEGIN");
        assert!(sqls.iter().any(|sql| sql.starts_with("INSERT INTO")));
        assert!(sqls.contains(&"ROLLBACK".to_string()));
        assert!(!sqls.contains(&"COMMIT".to_string()));
    }

    // "getRejectedCategoriesForTransactions [SQL-shape]"

    #[tokio::test]
    async fn get_short_circuits_when_transaction_ids_is_empty() {
        let executor = FakeExecutor::new();
        assert!(get_rejected_categories_for_transactions_on(&executor, &fake_user(), &[]).await.unwrap().is_empty());
        assert!(executor.calls().is_empty());
    }

    #[tokio::test]
    async fn get_scopes_to_the_user_takes_the_ids_in_an_in_list_and_orders_the_read() {
        let executor = FakeExecutor::new()
            .rows(vec![fake_row(json!({ "transaction_id": "tx-1" })), fake_row(json!({ "transaction_id": "tx-2" }))]);
        let ids = ["tx-1".to_string(), "tx-2".to_string(), "tx-3".to_string()];
        let result = get_rejected_categories_for_transactions_on(&executor, &fake_user(), &ids).await.unwrap();
        assert_eq!(
            executor.sql(0),
            "SELECT * FROM rejected_categories WHERE user_id = $1 AND transaction_id IN ($2, $3, $4) ORDER BY transaction_id, rejected_at DESC"
        );
        assert_eq!(executor.values(0), vec![json!("u-1"), json!("tx-1"), json!("tx-2"), json!("tx-3")]);
        assert_eq!(result.len(), 2);
    }

    #[tokio::test]
    async fn get_maps_each_row_to_its_json_with_rejected_at_preserved() {
        let executor = FakeExecutor::new().rows(vec![fake_row(json!({ "rejected_at": "2026-06-09T13:00:00Z" }))]);
        let result = get_rejected_categories_for_transactions_on(&executor, &fake_user(), &["tx-1".to_string()]).await.unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(
            json_stringify(&result[0]),
            r#"{"transaction_id":"tx-1","category_id":"cat-A","rejected_at":"2026-06-09T13:00:00Z"}"#
        );
    }

    // The statements' text is the TypeScript's, whitespace included.
    #[tokio::test]
    async fn the_statements_are_sent_as_the_typescript_writes_them() {
        let executor = FakeExecutor::new();
        add_rejected_category_on(&executor, &fake_user(), "tx-1", "cat-A").await.unwrap();
        remove_rejected_category_on(&executor, &fake_user(), "tx-1", "cat-A").await.unwrap();
        migrate_rejected_categories_on(&executor, "PENDING-1", "POSTED-1").await.unwrap();
        assert_eq!(
            statements(&executor),
            [
                "\n    INSERT INTO rejected_categories\n      (transaction_id, user_id, category_id)\n    SELECT t.transaction_id, t.user_id, $3\n    FROM transactions t\n    WHERE t.transaction_id = $1 AND t.user_id = ANY(sharing_user_ids($2))\n    ON CONFLICT (transaction_id, category_id)\n    DO UPDATE SET rejected_at = CURRENT_TIMESTAMP\n      WHERE rejected_categories.user_id = EXCLUDED.user_id\n    RETURNING *\n  ",
                "\n    DELETE FROM rejected_categories\n    WHERE user_id = ANY(sharing_user_ids($1))\n      AND transaction_id = $2\n      AND category_id = $3\n  ",
                "BEGIN",
                "\n      INSERT INTO rejected_categories\n        (transaction_id, user_id, category_id, rejected_at)\n      SELECT $1, user_id, category_id, rejected_at\n      FROM rejected_categories\n      WHERE transaction_id = $2\n      ON CONFLICT (transaction_id, category_id) DO NOTHING\n      ",
                "DELETE FROM rejected_categories WHERE transaction_id = $1",
                "COMMIT",
            ]
        );
    }
}
