//! `src/server/lib/postgres/repositories/split_transactions.ts`.

use serde_json::json;

use super::transactions::{date_range, id_context, id_of, utc_today, Deleted};
use crate::filters;
use crate::js::{Json, Obj};
use crate::server::logger;
use crate::server::postgres::client::{pool, Executor};
use crate::server::postgres::database::{
    error_result, no_change_result, success_result, Filters, QueryData, SearchFilters, UpsertResult,
};
use crate::server::postgres::models::{split_transaction, MaskedUser, UpdateArgs};

#[derive(Clone, Debug, Default)]
pub struct SearchSplitTransactionsOptions {
    pub transaction_id: Option<String>,
    pub account_id: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    /// When true, soft-deleted (`is_deleted = TRUE`) rows are INCLUDED in
    /// the response so the client can treat them as tombstones and evict
    /// them from its local cache. Defaults to `false`.
    pub include_deleted: bool,
}

/// A (partial) `JSONSplitTransaction` that names its `split_transaction_id`.
pub type PartialSplitTransaction = Obj;

async fn get_split_transactions_by_transaction(user: &MaskedUser, transaction_id: &str) -> anyhow::Result<Vec<Json>> {
    let models = split_transaction::TABLE
        .query(
            filters! { "user_id" => user.user_id.as_str(), "transaction_id" => transaction_id },
            SearchFilters::default(),
            None,
        )
        .await?;
    Ok(models.iter().map(split_transaction::to_json).collect())
}

fn search_filters(user: &MaskedUser, options: &SearchSplitTransactionsOptions) -> Filters {
    let mut filters = filters! { "user_id" => user.user_id.as_str() };
    if let Some(transaction_id) = options.transaction_id.as_deref().filter(|id| !id.is_empty()) {
        filters.extend(filters! { "transaction_id" => transaction_id });
    }
    if let Some(account_id) = options.account_id.as_deref().filter(|id| !id.is_empty()) {
        filters.extend(filters! { "account_id" => account_id });
    }
    filters
}

pub async fn search_split_transactions(user: &MaskedUser, options: &SearchSplitTransactionsOptions) -> anyhow::Result<Vec<Json>> {
    search_split_transactions_on(pool(), user, options).await
}

async fn search_split_transactions_on(
    executor: &dyn Executor,
    user: &MaskedUser,
    options: &SearchSplitTransactionsOptions,
) -> anyhow::Result<Vec<Json>> {
    let models = split_transaction::TABLE
        .query(
            search_filters(user, options),
            SearchFilters {
                date_range: date_range("updated", options.start_date.as_deref(), options.end_date.as_deref()),
                order_by: Some("date DESC".to_string()),
                exclude_deleted: Some(!options.include_deleted),
                ..Default::default()
            },
            Some(executor),
        )
        .await?;
    Ok(models.iter().map(split_transaction::to_json).collect())
}

/// The columns an update of `tx` sets: never its id or its owner.
fn update_row(tx: &PartialSplitTransaction, user_id: &str) -> QueryData {
    let mut row = split_transaction::from_json(tx, user_id);
    row.shift_remove("split_transaction_id");
    row.shift_remove("user_id");
    row
}

/// Never fails: a split that cannot be written is logged and reported with status 500.
pub async fn update_split_transactions(user: &MaskedUser, transactions: &[PartialSplitTransaction]) -> Vec<UpsertResult> {
    let mut results = Vec::new();

    for tx in transactions {
        let id = id_of(tx, "split_transaction_id");
        let row = update_row(tx, &user.user_id);

        // Scope the update to the caller's user_id: without this a caller
        // could patch another user's split transaction by id.
        // Soft-deleted rows keep their primary key but are invisible to every
        // read. Updating one would report a change no user can see; excluding
        // them here keeps "update" and "reachable" in agreement.
        let updated = split_transaction::TABLE
            .update(
                tx.get("split_transaction_id").unwrap_or(&Json::Null),
                &row,
                UpdateArgs { user_id: Some(&user.user_id), exclude_deleted: Some(true), ..Default::default() },
            )
            .await;
        match updated {
            Ok(Some(_)) => results.push(success_result(&id, Some(1))),
            Ok(None) => results.push(no_change_result(&id)),
            Err(error) => {
                logger::error(
                    "Failed to update split transaction",
                    Some(&id_context("splitTransactionId", tx, "split_transaction_id")),
                    Some(&error),
                );
                results.push(error_result(&id));
            }
        }
    }
    results
}

pub async fn delete_split_transactions(
    user: &MaskedUser,
    split_transaction_ids: &[String],
    client: Option<&dyn Executor>,
) -> anyhow::Result<Deleted> {
    if split_transaction_ids.is_empty() {
        return Ok(Deleted { deleted: 0 });
    }
    let ids: Vec<Json> = split_transaction_ids.iter().map(|id| json!(id)).collect();
    let deleted = split_transaction::TABLE.bulk_soft_delete(&ids, &[("user_id", json!(user.user_id))], client).await?;
    Ok(Deleted { deleted })
}

/// Soft-deletes the live splits of a transaction. They are looked up on the
/// pool, outside the caller's transaction, and deleted on `client`.
pub async fn delete_split_transactions_by_transaction(
    user: &MaskedUser,
    transaction_id: &str,
    client: Option<&dyn Executor>,
) -> anyhow::Result<Deleted> {
    let txs = get_split_transactions_by_transaction(user, transaction_id).await?;
    if txs.is_empty() {
        return Ok(Deleted { deleted: 0 });
    }
    let ids: Vec<String> = txs
        .iter()
        .map(|tx| tx.get("split_transaction_id").and_then(|id| id.as_str()).unwrap_or_default().to_string())
        .collect();
    delete_split_transactions(user, &ids, client).await
}

/// Re-points a pending transaction's live split rows onto the posted
/// transaction that supersedes it (pending→posted transition).
///
/// Without this, `sync_plaid_transactions` tombstones the pending row's
/// splits in the removal cascade (`delete_transactions` soft-deletes
/// splits by `transaction_id`, and the per-id helper repeats it) while
/// the label and `rejected_categories` migrate: the user's split
/// silently disappears and the parent's full amount reverts to a single
/// category in every rollup. The caller must run this AFTER the posted
/// row is upserted and BEFORE the removal cascade for the pending id:
/// the posted id arrives in the same batch, so it carries no user
/// splits of its own yet, and re-pointing first keeps the cascade from
/// ever seeing these rows under the pending id.
///
/// Guard: if the posted id already carries live splits (the posted row
/// was re-served in a later modified batch after splits were created
/// against it), merging the pending side's splits on top would stack
/// two sets under one parent and double-count in rollups. Skip and
/// warn instead; the pending side's splits stay put and the removal
/// cascade handles them as before.
///
/// Scoped to the caller's `user_id` and to live rows only: a split the
/// user already deleted stays deleted under the pending id. Bumps
/// `updated` so delta/cursor syncs pick the re-pointed rows up.
/// Returns the number of rows re-pointed.
pub async fn repoint_split_transactions_on_pending_posted(
    user: &MaskedUser,
    pending_transaction_id: &str,
    posted_transaction_id: &str,
) -> anyhow::Result<u64> {
    repoint_split_transactions_on(pool(), user, pending_transaction_id, posted_transaction_id).await
}

async fn repoint_split_transactions_on(
    executor: &dyn Executor,
    user: &MaskedUser,
    pending_transaction_id: &str,
    posted_transaction_id: &str,
) -> anyhow::Result<u64> {
    if pending_transaction_id == posted_transaction_id {
        return Ok(0);
    }
    // Non-canonical path: the posted row was re-served in a later batch
    // after live splits were created against it. Merging on top would
    // stack two sets under one parent, so skip and warn instead.
    let posted_live = executor
        .query(
            "
    SELECT 1 FROM split_transactions
    WHERE user_id = $1
      AND transaction_id = $2
      AND (is_deleted IS NULL OR is_deleted = FALSE)
    LIMIT 1
    ",
            &[json!(user.user_id), json!(posted_transaction_id)],
        )
        .await?;
    if posted_live.row_count.unwrap_or(0) > 0 {
        logger::warn(
            "Skipping split re-point: posted transaction already has live splits",
            Some(&crate::ctx! { "pending": pending_transaction_id, "posted": posted_transaction_id }),
            None,
        );
        return Ok(0);
    }
    let result = executor
        .query(
            "
    UPDATE split_transactions
    SET transaction_id = $3, updated = CURRENT_TIMESTAMP
    WHERE user_id = $1
      AND transaction_id = $2
      AND (is_deleted IS NULL OR is_deleted = FALSE)
    ",
            &[json!(user.user_id), json!(pending_transaction_id), json!(posted_transaction_id)],
        )
        .await?;
    Ok(result.row_count.unwrap_or(0))
}

#[derive(Clone, Debug, Default)]
pub struct CreateSplitTransactionInput {
    pub transaction_id: String,
    pub account_id: String,
}

fn new_split_transaction_row(user_id: &str, input: &CreateSplitTransactionInput, date: &str) -> QueryData {
    let mut tx = Obj::new();
    tx.insert("transaction_id".into(), json!(input.transaction_id));
    tx.insert("account_id".into(), json!(input.account_id));
    tx.insert("amount".into(), json!(0));
    tx.insert("date".into(), json!(date));
    tx.insert("custom_name".into(), json!(""));
    split_transaction::from_json(&tx, user_id)
}

pub async fn create_split_transaction(user: &MaskedUser, input: &CreateSplitTransactionInput) -> anyhow::Result<Json> {
    let row = new_split_transaction_row(&user.user_id, input, &utc_today());

    let Some(result) = split_transaction::TABLE.insert(&row, Some(&["*"]), false).await? else {
        anyhow::bail!("Failed to create split transaction");
    };
    let model = split_transaction::TABLE.validate(result)?;
    Ok(split_transaction::to_json(&model))
}

#[cfg(test)]
mod tests {
    use regex::Regex;
    use serde_json::json;

    use super::super::transactions::testing::{obj, user, FakeExecutor};
    use super::*;
    use crate::js::json_stringify;
    use crate::server::postgres::database::{build_update, AdditionalWhere, UpdateOptions};

    fn split_row(overrides: Json) -> Json {
        let mut row = obj(json!({
            "split_transaction_id": "split-1",
            "user_id": "usr-1",
            "transaction_id": "tx-1",
            "account_id": "acc-1",
            "amount": 12.5,
            "date": "2026-03-01",
            "custom_name": "groceries portion",
            "label_budget_id": null,
            "label_category_id": null,
            "label_memo": null,
            "label_category_confidence": null,
            "updated": "2026-03-01T00:00:00Z",
            "is_deleted": false,
        }));
        row.extend(obj(overrides));
        Json::Object(row)
    }

    fn matches(pattern: &str, text: &str) -> bool {
        Regex::new(pattern).unwrap().is_match(text)
    }

    // "searchSplitTransactions"

    #[tokio::test]
    async fn search_defaults_to_active_only() {
        let executor = FakeExecutor::new();
        search_split_transactions_on(&executor, &user("usr-1"), &SearchSplitTransactionsOptions::default()).await.unwrap();
        assert_eq!(
            executor.calls(),
            vec![(
                "SELECT * FROM split_transactions WHERE user_id = $1 AND (is_deleted IS NULL OR is_deleted = FALSE) ORDER BY date DESC".to_string(),
                vec![json!("usr-1")],
            )]
        );
    }

    #[tokio::test]
    async fn search_with_include_deleted_drops_the_soft_delete_predicate() {
        let executor = FakeExecutor::new();
        let options = SearchSplitTransactionsOptions { include_deleted: true, ..Default::default() };
        search_split_transactions_on(&executor, &user("usr-1"), &options).await.unwrap();
        assert!(!executor.sql(0).contains("is_deleted IS NULL OR is_deleted = FALSE"));
    }

    #[tokio::test]
    async fn search_passes_user_id_and_account_id_filters() {
        let executor = FakeExecutor::new();
        let options = SearchSplitTransactionsOptions { account_id: Some("acc-specific".into()), ..Default::default() };
        search_split_transactions_on(&executor, &user("usr-99"), &options).await.unwrap();
        assert!(executor.values(0).contains(&json!("usr-99")));
        assert!(executor.values(0).contains(&json!("acc-specific")));
    }

    #[tokio::test]
    async fn search_filters_by_transaction_then_account_and_skips_an_empty_one() {
        let executor = FakeExecutor::new();
        let options = SearchSplitTransactionsOptions {
            transaction_id: Some("tx-9".into()),
            account_id: Some("acc-9".into()),
            ..Default::default()
        };
        search_split_transactions_on(&executor, &user("usr-1"), &options).await.unwrap();
        assert!(executor.sql(0).starts_with("SELECT * FROM split_transactions WHERE user_id = $1 AND transaction_id = $2 AND account_id = $3 AND "));
        assert_eq!(executor.values(0), vec![json!("usr-1"), json!("tx-9"), json!("acc-9")]);

        let executor = FakeExecutor::new();
        let options =
            SearchSplitTransactionsOptions { transaction_id: Some(String::new()), account_id: Some(String::new()), ..Default::default() };
        search_split_transactions_on(&executor, &user("usr-1"), &options).await.unwrap();
        assert_eq!(executor.values(0), vec![json!("usr-1")]);
    }

    #[tokio::test]
    async fn search_applies_the_date_range_on_the_updated_column_when_provided() {
        let executor = FakeExecutor::new();
        let options = SearchSplitTransactionsOptions {
            start_date: Some("2026-03-01".into()),
            end_date: Some("2026-04-01".into()),
            ..Default::default()
        };
        search_split_transactions_on(&executor, &user("usr-1"), &options).await.unwrap();
        assert!(executor.sql(0).contains("updated >= $2 AND updated <= $3"));
        assert!(executor.values(0).contains(&json!("2026-03-01")));
        assert!(executor.values(0).contains(&json!("2026-04-01")));
    }

    #[tokio::test]
    async fn search_emits_is_deleted_alongside_the_existing_fields() {
        let executor = FakeExecutor::new().rows(vec![split_row(json!({ "is_deleted": true }))]);
        let options = SearchSplitTransactionsOptions { include_deleted: true, ..Default::default() };
        let result = search_split_transactions_on(&executor, &user("usr-1"), &options).await.unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["is_deleted"], json!(true));
        assert_eq!(result[0]["split_transaction_id"], json!("split-1"));
    }

    #[tokio::test]
    async fn search_returns_is_deleted_false_for_active_rows_when_the_column_is_null() {
        let executor = FakeExecutor::new().rows(vec![split_row(json!({ "is_deleted": null }))]);
        let result =
            search_split_transactions_on(&executor, &user("usr-1"), &SearchSplitTransactionsOptions::default()).await.unwrap();
        assert_eq!(result[0]["is_deleted"], json!(false));
    }

    // "repointSplitTransactionsOnPendingPosted"

    #[tokio::test]
    async fn repoint_updates_live_splits_to_the_posted_id_scoped_to_the_user() {
        // The guard finds no live splits on the posted id; the UPDATE re-points two.
        let executor = FakeExecutor::new().count(0).count(2);
        let n = repoint_split_transactions_on(&executor, &user("usr-1"), "tx-pending", "tx-posted").await.unwrap();
        assert_eq!(executor.calls().len(), 2);
        assert!(matches(r"SELECT 1 FROM split_transactions", &executor.sql(0)));
        assert_eq!(executor.values(0), vec![json!("usr-1"), json!("tx-posted")]);
        let sql = executor.sql(1);
        assert!(matches(r"UPDATE split_transactions", &sql));
        assert!(matches(r"SET\s+transaction_id\s*=\s*\$3", &sql));
        assert!(matches(r"updated\s*=\s*CURRENT_TIMESTAMP", &sql));
        assert!(matches(r"user_id\s*=\s*\$1", &sql));
        assert!(matches(r"transaction_id\s*=\s*\$2", &sql));
        assert!(matches(r"is_deleted IS NULL OR is_deleted = FALSE", &sql));
        assert_eq!(executor.values(1), vec![json!("usr-1"), json!("tx-pending"), json!("tx-posted")]);
        assert_eq!(n, 2);
    }

    #[tokio::test]
    async fn repoint_returns_0_when_no_live_split_matched() {
        let executor = FakeExecutor::new().count(0).count(0);
        assert_eq!(repoint_split_transactions_on(&executor, &user("usr-1"), "tx-pending", "tx-posted").await.unwrap(), 0);
    }

    #[tokio::test]
    async fn repoint_is_a_no_op_without_issuing_a_query_when_pending_and_posted_ids_match() {
        let executor = FakeExecutor::new();
        assert_eq!(repoint_split_transactions_on(&executor, &user("usr-1"), "tx-same", "tx-same").await.unwrap(), 0);
        assert!(executor.calls().is_empty());
    }

    #[tokio::test]
    async fn repoint_skips_the_update_when_the_posted_id_already_has_live_splits() {
        let executor = FakeExecutor::new().rows(vec![json!({ "?column?": 1 })]);
        assert_eq!(repoint_split_transactions_on(&executor, &user("usr-1"), "tx-pending", "tx-posted").await.unwrap(), 0);
        assert_eq!(executor.calls().len(), 1);
        assert!(matches(r"SELECT 1 FROM split_transactions", &executor.sql(0)));
        assert!(matches(r"is_deleted IS NULL OR is_deleted = FALSE", &executor.sql(0)));
    }

    #[tokio::test]
    async fn repoint_guard_select_is_scoped_to_the_posted_id_and_live_rows_only() {
        let executor = FakeExecutor::new().count(0).count(0);
        repoint_split_transactions_on(&executor, &user("usr-1"), "tx-pending", "tx-posted").await.unwrap();
        assert!(matches(r"transaction_id\s*=\s*\$2", &executor.sql(0)));
        assert!(matches(r"LIMIT 1", &executor.sql(0)));
        assert_eq!(executor.values(0), vec![json!("usr-1"), json!("tx-posted")]);
    }

    #[tokio::test]
    async fn repoint_fails_when_the_guard_fails_without_updating() {
        let executor = FakeExecutor::new().failure("guard failed");
        let error = repoint_split_transactions_on(&executor, &user("usr-1"), "tx-pending", "tx-posted").await.unwrap_err();
        assert_eq!(error.to_string(), "guard failed");
        assert_eq!(executor.calls().len(), 1);
    }

    // The statements' text is the TypeScript's, whitespace included.
    #[tokio::test]
    async fn repoint_sends_the_statements_as_the_typescript_writes_them() {
        let executor = FakeExecutor::new();
        repoint_split_transactions_on(&executor, &user("usr-1"), "tx-pending", "tx-posted").await.unwrap();
        assert_eq!(
            executor.sql(0),
            "\n    SELECT 1 FROM split_transactions\n    WHERE user_id = $1\n      AND transaction_id = $2\n      AND (is_deleted IS NULL OR is_deleted = FALSE)\n    LIMIT 1\n    "
        );
        assert_eq!(
            executor.sql(1),
            "\n    UPDATE split_transactions\n    SET transaction_id = $3, updated = CURRENT_TIMESTAMP\n    WHERE user_id = $1\n      AND transaction_id = $2\n      AND (is_deleted IS NULL OR is_deleted = FALSE)\n    "
        );
    }

    // Updates, deletes and the shell row.

    /// The UPDATE `update_split_transactions` builds for `tx`, or `None` when it sets nothing.
    fn update_statement(tx: Json) -> Option<(String, Vec<Json>)> {
        let tx = obj(tx);
        let row = update_row(&tx, "usr-1");
        let options = UpdateOptions {
            additional_where: &[AdditionalWhere::new("user_id", "usr-1")],
            returning: &["split_transaction_id"],
            exclude_deleted: true,
        };
        build_update("split_transactions", "split_transaction_id", tx.get("split_transaction_id").unwrap(), &row, &options)
            .map(|query| (query.sql, query.values))
    }

    #[test]
    fn an_update_is_scoped_to_the_owner_and_to_live_rows_and_never_sets_the_key_or_the_owner() {
        let (sql, values) = update_statement(json!({
            "split_transaction_id": "split-1",
            "user_id": "usr-2",
            "amount": 4.5,
            "label": { "category_id": null, "memo": "half" },
        }))
        .unwrap();
        assert_eq!(
            sql,
            "UPDATE split_transactions SET updated = CURRENT_TIMESTAMP, amount = $1, label_category_id = $2, label_memo = $3 WHERE split_transaction_id = $4 AND user_id = $5 AND (is_deleted IS NULL OR is_deleted = FALSE) RETURNING split_transaction_id"
        );
        assert_eq!(values, vec![json!(4.5), Json::Null, json!("half"), json!("split-1"), json!("usr-1")]);
        assert!(update_statement(json!({ "split_transaction_id": "split-1" })).is_none());
    }

    #[tokio::test]
    async fn update_returns_empty_array_for_empty_input() {
        assert!(update_split_transactions(&user("usr-1"), &[]).await.is_empty());
    }

    #[tokio::test]
    async fn delete_soft_deletes_the_users_splits_by_id_on_the_given_client() {
        let executor = FakeExecutor::new().count(2);
        let ids = ["split-1".to_string(), "split-2".to_string()];
        assert_eq!(delete_split_transactions(&user("usr-1"), &ids, Some(&executor)).await.unwrap(), Deleted { deleted: 2 });
        assert_eq!(
            executor.calls(),
            vec![(
                "UPDATE split_transactions SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE split_transaction_id IN ($1, $2) AND user_id = $3 RETURNING split_transaction_id".to_string(),
                vec![json!("split-1"), json!("split-2"), json!("usr-1")],
            )]
        );

        let executor = FakeExecutor::new();
        assert_eq!(delete_split_transactions(&user("usr-1"), &[], Some(&executor)).await.unwrap(), Deleted { deleted: 0 });
        assert!(executor.calls().is_empty());
    }

    #[test]
    fn a_new_split_starts_as_an_unnamed_zero_amount_row() {
        let input = CreateSplitTransactionInput { transaction_id: "tx-1".into(), account_id: "acc-1".into() };
        assert_eq!(
            json_stringify(&Json::Object(new_split_transaction_row("usr-1", &input, "2026-11-21"))),
            r#"{"user_id":"usr-1","transaction_id":"tx-1","account_id":"acc-1","amount":0,"date":"2026-11-21","custom_name":""}"#
        );
    }
}
