//! `src/server/lib/postgres/repositories/items.ts`.

use serde_json::json;

use super::transactions::soft_delete_transaction_pairs_by_accounts;
use crate::filters;
use crate::server::postgres::database::shared_with;
use crate::js::{to_js_string, Json, JsDate, Obj};
use crate::server::logger;
use crate::server::postgres::client::{pool, with_transaction, Executor};
use crate::server::postgres::database::{error_result, success_result, SearchFilters, UpsertResult};
use crate::server::postgres::models::base::str_of;
use crate::server::postgres::models::{
    account, holding, investment_transaction, item, snapshot, split_transaction, transaction, MaskedUser, UpdateArgs,
};

/// `PartialItem`: an item's `item_id` with any of the other `JSONItem` fields.
pub type PartialItem = Obj;

pub async fn get_item(user: &MaskedUser, item_id: &str) -> anyhow::Result<Option<Json>> {
    let model = item::TABLE.query_one(filters! { "user_id" => shared_with(user), "item_id" => item_id }).await?;
    Ok(model.map(|model| item::to_json(&model)))
}

pub async fn get_all_items() -> anyhow::Result<Vec<Json>> {
    let models = item::TABLE.query(Vec::new(), SearchFilters::default(), None).await?;
    Ok(models.iter().map(item::to_json).collect())
}

/// The filters of `search_items`; one that is absent or empty is not applied.
#[derive(Clone, Debug, Default)]
pub struct SearchItemsOptions {
    pub item_id: Option<String>,
    pub institution_id: Option<String>,
    /// An `ItemProvider`: `plaid`, `simple_fin` or `manual`.
    pub provider: Option<String>,
}

pub async fn search_items(user: &MaskedUser, options: SearchItemsOptions) -> anyhow::Result<Vec<Json>> {
    let mut filters = filters! { "user_id" => shared_with(user) };
    if let Some(item_id) = options.item_id.filter(|item_id| !item_id.is_empty()) {
        filters.extend(filters! { "item_id" => item_id });
    }
    if let Some(institution_id) = options.institution_id.filter(|institution_id| !institution_id.is_empty()) {
        filters.extend(filters! { "institution_id" => institution_id });
    }
    if let Some(provider) = options.provider.filter(|provider| !provider.is_empty()) {
        filters.extend(filters! { "provider" => provider });
    }

    let models = item::TABLE.query(filters, SearchFilters::default(), None).await?;
    Ok(models.iter().map(item::to_json).collect())
}

/// Projects an item to the shape the browser may see. The server-side
/// credential (`access_token`) never crosses to the client.
pub fn to_client_item(item: &Json) -> Json {
    let rest: Obj = match item {
        Json::Object(item) => item.iter().filter(|(key, _)| *key != "access_token").map(|(key, value)| (key.clone(), value.clone())).collect(),
        _ => Obj::new(),
    };
    Json::Object(rest)
}

/// What `get_user_item` finds: an item and the user it belongs to.
#[derive(Clone, Debug)]
pub struct UserItem {
    pub user: MaskedUser,
    pub item: Json,
}

pub async fn get_user_item(item_id: &str) -> anyhow::Result<Option<UserItem>> {
    get_user_item_of(&json!(item_id)).await
}

/// [`get_user_item`] for an id that may be any value a request carried: it is
/// bound as it is, so a number fails in the database as it does in the
/// TypeScript, and `undefined` is passed as null.
pub async fn get_user_item_of(item_id: &Json) -> anyhow::Result<Option<UserItem>> {
    // JOIN with users to attach `username`, which is outside `Table::query`'s surface.
    let result = pool()
        .query(
            "SELECT i.*, u.username FROM items i JOIN users u ON i.user_id = u.user_id WHERE i.item_id = $1 AND (i.is_deleted IS NULL OR i.is_deleted = FALSE)",
            std::slice::from_ref(item_id),
        )
        .await?;
    let Some(row) = result.rows.into_iter().next() else { return Ok(None) };
    let user = MaskedUser { user_id: str_of(&row, "user_id").to_string(), username: str_of(&row, "username").to_string() };
    Ok(Some(UserItem { user, item: item::to_json(&item::TABLE.validate(row)?) }))
}

/// Columns an item conflict may rewrite. `Table::upsert` otherwise defaults to
/// every supplied key, which lets a colliding `item_id` reassign the row's
/// owner.
const ITEM_UPDATE_COLUMNS: &[&str] = &[
    "access_token",
    "institution_id",
    "available_products",
    "cursor",
    "status",
    "status_reason",
    "provider",
    "last_sync_status",
    "last_sync_at",
    "last_sync_error",
    "raw",
];

/// Writes each item, reporting one result per item: a failed write is logged
/// and answers 500 for that item alone.
pub async fn upsert_items(user: &MaskedUser, items: &[PartialItem], client: Option<&dyn Executor>) -> Vec<UpsertResult> {
    let mut results = Vec::new();

    for item in items {
        let item_id = item.get("item_id").map(to_js_string).unwrap_or_default();
        let row = item::from_json(item, &user.user_id);
        match item::TABLE.upsert(&row, Some(ITEM_UPDATE_COLUMNS), client, None).await {
            Ok(_) => results.push(success_result(&item_id, Some(1))),
            Err(error) => {
                logger::error("Failed to upsert item", Some(&crate::ctx! { "itemId": item.get("item_id") }), Some(&error));
                results.push(error_result(&item_id));
            }
        }
    }
    results
}

pub async fn update_item_status(
    user: &MaskedUser,
    item_id: &str,
    status: &str,
    status_reason: Option<&str>,
) -> anyhow::Result<bool> {
    let mut data = Obj::new();
    data.insert("status".into(), json!(status));
    data.insert("status_reason".into(), json!(status_reason));
    let updated =
        item::TABLE.update(&json!(item_id), &data, UpdateArgs { user_id: Some(shared_with(user)), ..Default::default() }).await?;
    Ok(updated.is_some())
}

/// The outcome of one sync attempt, as `update_item_sync_status` stores it.
#[derive(Clone, Debug, Default)]
pub struct SyncResult {
    pub success: bool,
    pub error: Option<String>,
}

pub async fn update_item_sync_status(item_id: &str, result: &SyncResult) -> anyhow::Result<bool> {
    let mut data = Obj::new();
    data.insert("last_sync_status".into(), json!(if result.success { "success" } else { "failed" }));
    data.insert("last_sync_at".into(), JsDate::now().to_json());
    data.insert("last_sync_error".into(), json!(result.error));
    let updated = item::TABLE.update(&json!(item_id), &data, UpdateArgs::default()).await?;
    Ok(updated.is_some())
}

/// Soft-deletes the user's item with its accounts and everything they hold,
/// in one transaction. `false` when there was no such item to delete.
pub async fn delete_item(user: &MaskedUser, item_id: &str) -> anyhow::Result<bool> {
    let accounts = account::TABLE
        .query(filters! { "item_id" => item_id, "user_id" => shared_with(user) }, SearchFilters::default(), None)
        .await?;
    let account_ids: Vec<String> = accounts.iter().map(|account| str_of(account, "account_id").to_string()).collect();

    let (user, item_id) = (user.clone(), item_id.to_string());
    with_transaction(|client| Box::pin(async move { soft_delete_item(&user, &item_id, &account_ids, client).await })).await
}

/// The statements of `delete_item`, on the transaction's `client`.
async fn soft_delete_item(
    user: &MaskedUser,
    item_id: &str,
    account_ids: &[String],
    client: &dyn Executor,
) -> anyhow::Result<bool> {
    let owner = [("user_id", shared_with(user))];
    let ids: Vec<Json> = account_ids.iter().map(|account_id| json!(account_id)).collect();
    let accounts = Json::Array(ids.clone());

    // Each cascade covers all of the item's accounts in one round trip
    // (`column = ANY($1)`) instead of six queries per account. An empty list
    // deletes nothing and queries nothing.
    transaction::TABLE.bulk_soft_delete_by_column("account_id", &accounts, Some(shared_with(user)), Some(client)).await?;
    investment_transaction::TABLE.bulk_soft_delete_by_column("account_id", &accounts, Some(shared_with(user)), Some(client)).await?;
    split_transaction::TABLE.bulk_soft_delete_by_column("account_id", &accounts, Some(shared_with(user)), Some(client)).await?;
    soft_delete_transaction_pairs_by_accounts(user, account_ids, Some(client)).await?;
    // Account-balance snapshots store the account in `account_id`; holding
    // snapshots store it in `holding_account_id` (their `account_id` is NULL).
    // Soft-delete both so removing an item leaves no orphaned holding history.
    snapshot::TABLE.bulk_soft_delete_by_column("account_id", &accounts, Some(shared_with(user)), Some(client)).await?;
    snapshot::TABLE.bulk_soft_delete_by_column("holding_account_id", &accounts, Some(shared_with(user)), Some(client)).await?;
    holding::TABLE.bulk_soft_delete_by_column("account_id", &accounts, Some(shared_with(user)), Some(client)).await?;

    if !ids.is_empty() {
        account::TABLE.bulk_soft_delete(&ids, &owner, Some(client)).await?;
    }

    let deleted = item::TABLE.bulk_soft_delete(&[json!(item_id)], &owner, Some(client)).await?;
    Ok(deleted > 0)
}

/// What the tests of the account-side repositories share.
#[cfg(test)]
pub(super) mod testing {
    use std::sync::Mutex;

    use async_trait::async_trait;

    use crate::js::{Json, Obj};
    use crate::server::postgres::client::{DbError, Executor, QueryResult};
    use crate::server::postgres::models::MaskedUser;

    /// The user of the TypeScript tests.
    pub fn test_user() -> MaskedUser {
        MaskedUser { user_id: "usr-1".to_string(), username: "hoie".to_string() }
    }

    /// The object a `json!` literal wrote.
    pub fn obj(value: Json) -> Obj {
        match value {
            Json::Object(map) => map,
            other => panic!("not an object: {other}"),
        }
    }

    /// An executor that records each statement and answers it with no rows
    /// and a row count of one, as the TypeScript tests' `createFakeSql` stub
    /// does; a failing one refuses every statement instead.
    #[derive(Default)]
    pub struct FakeExecutor {
        calls: Mutex<Vec<(String, Vec<Json>)>>,
        failing: bool,
    }

    impl FakeExecutor {
        pub fn failing() -> Self {
            FakeExecutor { failing: true, ..Default::default() }
        }

        /// Every `(sql, values)` queried so far.
        pub fn calls(&self) -> Vec<(String, Vec<Json>)> {
            self.calls.lock().unwrap().clone()
        }

        /// The SQL of every statement queried so far.
        pub fn statements(&self) -> Vec<String> {
            self.calls().into_iter().map(|(sql, _)| sql).collect()
        }
    }

    #[async_trait]
    impl Executor for FakeExecutor {
        async fn query(&self, text: &str, values: &[Json]) -> anyhow::Result<QueryResult> {
            self.calls.lock().unwrap().push((text.to_string(), values.to_vec()));
            if self.failing {
                return Err(DbError { code: None, message: "DB unavailable".to_string() }.into());
            }
            Ok(QueryResult { rows: Vec::new(), row_count: Some(1) })
        }
    }

    /// `updateColumnsOf` of `scripts/test-helpers.ts`: the columns an
    /// upsert's `DO UPDATE SET` rewrites.
    pub fn update_columns_of(sql: &str) -> Vec<String> {
        let Some(clause) = sql.split("DO UPDATE SET").nth(1) else { return Vec::new() };
        let clause = clause.split(" RETURNING").next().unwrap_or(clause);
        clause
            .split(',')
            .map(|part| part.trim().split('=').next().unwrap_or("").trim().to_string())
            .filter(|column| !column.is_empty())
            .collect()
    }

    /// The table of each `UPDATE` among `statements`, in order.
    pub fn updated_tables(statements: &[String]) -> Vec<String> {
        statements
            .iter()
            .filter_map(|sql| sql.strip_prefix("UPDATE "))
            .map(|rest| rest.split(' ').next().unwrap_or("").to_string())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::testing::{obj, test_user, updated_tables, FakeExecutor};
    use super::*;

    // `items.test.ts`, "deleteItem".

    async fn delete_item_statements(account_ids: &[&str]) -> Vec<(String, Vec<Json>)> {
        let client = FakeExecutor::default();
        let account_ids: Vec<String> = account_ids.iter().map(|id| id.to_string()).collect();
        soft_delete_item(&test_user(), "item-del", &account_ids, &client).await.unwrap();
        client.calls()
    }

    #[tokio::test]
    async fn delete_item_soft_deletes_snapshots_by_both_account_id_and_holding_account_id() {
        // Account-balance snapshots live under `account_id`; holding snapshots
        // live under `holding_account_id` (their `account_id` is NULL). Both
        // passes must fire or the item-delete path orphans the holding history.
        let calls = delete_item_statements(&["acc-del"]).await;
        let snapshot_deletes: Vec<&String> =
            calls.iter().map(|(sql, _)| sql).filter(|sql| sql.starts_with("UPDATE snapshots SET is_deleted")).collect();
        assert!(snapshot_deletes.iter().any(|sql| sql.contains("WHERE account_id = ")));
        assert!(snapshot_deletes.iter().any(|sql| sql.contains("WHERE holding_account_id = ")));
    }

    #[tokio::test]
    async fn delete_item_cascades_to_transaction_pairs_on_both_join_columns_scoped_to_the_user() {
        let calls = delete_item_statements(&["acc-del"]).await;
        let pair_deletes: Vec<&(String, Vec<Json>)> =
            calls.iter().filter(|(sql, _)| sql.starts_with("UPDATE transaction_pairs")).collect();
        assert_eq!(pair_deletes.len(), 2);
        assert!(pair_deletes.iter().any(|(sql, _)| sql.contains("WHERE transaction_id_a IN (SELECT")));
        assert!(pair_deletes.iter().any(|(sql, _)| sql.contains("WHERE transaction_id_b IN (SELECT")));
        for (sql, values) in pair_deletes {
            // The subquery selects transaction ids for the item's accounts, and it
            // must NOT exclude soft-deleted rows: the transactions this cascade
            // travels through were soft-deleted earlier in the same transaction.
            assert!(sql.contains("SELECT transaction_id FROM transactions WHERE account_id = ANY($1))"));
            assert!(!sql.contains("is_deleted = FALSE"));
            // Scoped to the owner: a pair is never reachable across users.
            assert!(sql.contains("AND user_id = ANY(sharing_user_ids($2))"));
            // The `updated` bump is what lets a delta sync deliver the tombstone.
            assert!(sql.contains("SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP"));
            assert_eq!(values, &vec![json!(["acc-del"]), json!("usr-1")]);
        }
    }

    #[tokio::test]
    async fn delete_item_runs_the_pairs_cascade_after_the_transactions_soft_delete() {
        // The transactions UPDATE holds an exclusive row lock until commit, which
        // is what stops a concurrent pairing from minting a pair behind this cascade.
        let calls = delete_item_statements(&["acc-del"]).await;
        let position = |prefix: &str| calls.iter().position(|(sql, _)| sql.starts_with(prefix)).unwrap();
        assert!(position("UPDATE transactions SET is_deleted") < position("UPDATE transaction_pairs"));
    }

    #[tokio::test]
    async fn delete_item_writes_every_table_of_the_cascade_in_order() {
        let calls = delete_item_statements(&["acc-del"]).await;
        let statements: Vec<String> = calls.into_iter().map(|(sql, _)| sql).collect();
        assert_eq!(
            updated_tables(&statements),
            [
                "transactions",
                "investment_transactions",
                "split_transactions",
                "transaction_pairs",
                "transaction_pairs",
                "snapshots",
                "snapshots",
                "holdings",
                "accounts",
                "items",
            ]
        );
    }

    #[tokio::test]
    async fn delete_item_skips_every_account_cascade_when_the_item_owns_no_accounts() {
        let calls = delete_item_statements(&[]).await;
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0].0,
            "UPDATE items SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE item_id IN ($1) AND user_id = ANY(sharing_user_ids($2)) RETURNING item_id"
        );
        assert_eq!(calls[0].1, vec![json!("item-del"), json!("usr-1")]);
    }

    // `items.test.ts`, "upsertItems".

    #[tokio::test]
    async fn upsert_items_writes_through_the_executor_it_is_handed() {
        let client = FakeExecutor::default();
        let results = upsert_items(&test_user(), &[obj(json!({ "item_id": "item-1" }))], Some(&client)).await;
        assert_eq!(client.calls().len(), 1);
        assert_eq!(results.len(), 1);
        assert_eq!((results[0].id.as_str(), results[0].status), ("item-1", 200));
    }

    #[tokio::test]
    async fn upsert_items_is_an_upsert_so_a_supplied_id_never_keys_a_bare_update() {
        let client = FakeExecutor::default();
        upsert_items(&test_user(), &[obj(json!({ "item_id": "item-1" }))], Some(&client)).await;
        let statements = client.statements();
        assert_eq!(statements.iter().filter(|sql| sql.contains("ON CONFLICT")).count(), 1);
        assert!(updated_tables(&statements).is_empty());
    }

    #[tokio::test]
    async fn a_conflicting_item_id_rewrites_the_items_fields_never_its_owner() {
        let client = FakeExecutor::default();
        upsert_items(&test_user(), &[obj(json!({ "item_id": "item-1", "institution_id": "ins-1" }))], Some(&client)).await;
        let sql = client.statements().remove(0);
        let set_clause = sql.split("DO UPDATE SET ").nth(1).unwrap().split(" RETURNING").next().unwrap();
        assert_eq!(set_clause, "institution_id = EXCLUDED.institution_id, raw = EXCLUDED.raw, updated = CURRENT_TIMESTAMP");
    }

    #[tokio::test]
    async fn upsert_items_answers_500_for_an_item_whose_write_fails() {
        let client = FakeExecutor::failing();
        let items = [obj(json!({ "item_id": "item-1" })), obj(json!({ "item_id": "item-2" }))];
        let results = upsert_items(&test_user(), &items, Some(&client)).await;
        let reported: Vec<(&str, u16)> = results.iter().map(|result| (result.id.as_str(), result.status)).collect();
        assert_eq!(reported, [("item-1", 500), ("item-2", 500)]);
    }

    #[tokio::test]
    async fn upsert_items_with_no_items_writes_nothing() {
        let client = FakeExecutor::default();
        assert!(upsert_items(&test_user(), &[], Some(&client)).await.is_empty());
        assert!(client.calls().is_empty());
    }

    // `items.test.ts`, "toClientItem".

    #[test]
    fn to_client_item_strips_the_server_side_credential_and_keeps_every_other_field() {
        let item = json!({
            "item_id": "i-1",
            "access_token": "access-production-secret",
            "institution_id": "ins-1",
            "available_products": [],
            "provider": "plaid",
            "status": "ok",
        });
        let client = to_client_item(&item);
        assert_eq!(
            crate::js::json_stringify(&client),
            r#"{"item_id":"i-1","institution_id":"ins-1","available_products":[],"provider":"plaid","status":"ok"}"#
        );
        // The input is not changed: the server still needs the credential.
        assert_eq!(item["access_token"], json!("access-production-secret"));
    }
}
