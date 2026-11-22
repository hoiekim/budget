//! `src/server/lib/postgres/repositories/accounts.ts`.

use serde_json::json;

use super::transactions::soft_delete_transaction_pairs_by_accounts;
use crate::filters;
use crate::server::postgres::database::shared_with;
use crate::js::{to_js_string, Json, Obj};
use crate::server::logger;
use crate::server::postgres::client::{with_transaction, Executor};
use crate::server::postgres::database::{error_result, no_change_result, success_result, QueryData, SearchFilters, UpsertResult};
use crate::server::postgres::models::{
    account, holding, investment_transaction, snapshot, split_transaction, transaction, MaskedUser, UpdateArgs,
};

/// `PartialAccount`: an account's `account_id` with any of the other `JSONAccount` fields.
pub type PartialAccount = Obj;

pub async fn get_accounts(user: &MaskedUser) -> anyhow::Result<Vec<Json>> {
    let models = account::TABLE.query(filters! { "user_id" => shared_with(user) }, SearchFilters::default(), None).await?;
    Ok(models.iter().map(account::to_json).collect())
}

pub async fn get_account(user: &MaskedUser, account_id: &str) -> anyhow::Result<Option<Json>> {
    let model = account::TABLE.query_one(filters! { "user_id" => shared_with(user), "account_id" => account_id }).await?;
    Ok(model.map(|model| account::to_json(&model)))
}

pub async fn search_accounts_by_item_id(user: &MaskedUser, item_id: &str) -> anyhow::Result<Vec<Json>> {
    let models = account::TABLE
        .query(filters! { "user_id" => shared_with(user), "item_id" => item_id }, SearchFilters::default(), None)
        .await?;
    Ok(models.iter().map(account::to_json).collect())
}

/// The filters of `search_accounts`; one that is absent or empty is not applied.
#[derive(Clone, Debug, Default)]
pub struct SearchAccountsOptions {
    pub account_id: Option<String>,
    pub item_id: Option<String>,
    pub institution_id: Option<String>,
    pub r#type: Option<String>,
}

pub async fn search_accounts(user: &MaskedUser, options: SearchAccountsOptions) -> anyhow::Result<Vec<Json>> {
    let mut filters = filters! { "user_id" => shared_with(user) };
    if let Some(account_id) = options.account_id.filter(|account_id| !account_id.is_empty()) {
        filters.extend(filters! { "account_id" => account_id });
    }
    if let Some(item_id) = options.item_id.filter(|item_id| !item_id.is_empty()) {
        filters.extend(filters! { "item_id" => item_id });
    }
    if let Some(institution_id) = options.institution_id.filter(|institution_id| !institution_id.is_empty()) {
        filters.extend(filters! { "institution_id" => institution_id });
    }
    if let Some(account_type) = options.r#type.filter(|account_type| !account_type.is_empty()) {
        filters.extend(filters! { "type" => account_type });
    }

    let models = account::TABLE.query(filters, SearchFilters::default(), None).await?;
    Ok(models.iter().map(account::to_json).collect())
}

pub async fn search_accounts_by_id(user: &MaskedUser, account_ids: &[String]) -> anyhow::Result<Vec<Json>> {
    if account_ids.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<Json> = account_ids.iter().map(|account_id| json!(account_id)).collect();
    let models = account::TABLE.query_by_ids(&ids, &[("user_id", shared_with(user))]).await?;
    Ok(models.iter().map(account::to_json).collect())
}

/// What `create_manual_account` makes the account from.
#[derive(Clone, Debug, Default)]
pub struct ManualAccountInput {
    pub item_id: String,
    /// `Unknown` when absent.
    pub institution_id: Option<String>,
    /// An `AccountGraphOptions` object.
    pub graph_options: Option<Json>,
}

/// The row of a new manual account.
fn manual_account_row(user: &MaskedUser, account_id: &str, input: &ManualAccountInput) -> QueryData {
    let mut account = Obj::new();
    account.insert("account_id".into(), json!(account_id));
    account.insert("item_id".into(), json!(input.item_id));
    account.insert("institution_id".into(), json!(input.institution_id.as_deref().unwrap_or("Unknown")));
    account.insert("name".into(), json!("Unknown"));
    account.insert("type".into(), json!("other"));
    account.insert("subtype".into(), Json::Null);
    account.insert(
        "balances".into(),
        json!({ "current": null, "available": null, "limit": null, "iso_currency_code": null, "unofficial_currency_code": null }),
    );
    account.insert("mask".into(), Json::Null);
    account.insert("official_name".into(), Json::Null);
    if let Some(graph_options) = &input.graph_options {
        account.insert("graphOptions".into(), graph_options.clone());
    }
    let mut row = account::from_json(&account, &user.user_id);
    // `raw` exists to hold a provider's payload; a manual account has none,
    // so `from_json` would fill it with a verbatim copy of the caller-supplied
    // init: unbounded, unvalidated, and a duplicate of the columns written
    // beside it.
    row.shift_remove("raw");
    row
}

/// Mints a shell `accounts` row for a manual item. The `account_id` is
/// server-generated (`manual-<uuid>`) so the client never needs to invent
/// one, as for manual transactions. Ownership and provider gating live at the
/// route boundary. `None` when the account could not be created; the failure
/// is logged.
pub async fn create_manual_account(user: &MaskedUser, input: ManualAccountInput) -> Option<Json> {
    let account_id = format!("manual-{}", uuid::Uuid::new_v4());
    let row = manual_account_row(user, &account_id, &input);
    let created = async {
        let Some(inserted) = account::TABLE.insert(&row, Some(&["*"]), false).await? else { return Ok(None) };
        anyhow::Ok(Some(account::to_json(&account::TABLE.validate(inserted)?)))
    };
    match created.await {
        Ok(created) => created,
        Err(error) => {
            logger::error(
                "Failed to create manual account",
                Some(&crate::ctx! { "account_id": account_id, "item_id": input.item_id }),
                Some(&error),
            );
            None
        }
    }
}

/// Writes each account, reporting one result per account: a failed write is
/// logged and answers 500 for that account alone.
pub async fn upsert_accounts(user: &MaskedUser, accounts: &[Obj], client: Option<&dyn Executor>) -> Vec<UpsertResult> {
    let mut results = Vec::new();

    for account in accounts {
        let account_id = account.get("account_id").map(to_js_string).unwrap_or_default();
        let row = account::from_json(account, &user.user_id);
        match account::TABLE.upsert(&row, None, client).await {
            Ok(_) => results.push(success_result(&account_id, Some(1))),
            Err(error) => {
                logger::error("Failed to upsert account", Some(&crate::ctx! { "accountId": account.get("account_id") }), Some(&error));
                results.push(error_result(&account_id));
            }
        }
    }
    results
}

/// The columns `update_accounts` sets for one account.
fn account_update_row(user: &MaskedUser, account: &PartialAccount) -> QueryData {
    let mut row = account::from_json(account, &user.user_id);
    row.shift_remove("account_id");
    row.shift_remove("user_id");
    // `institution_id` and `item_id` are create-only: an edit body naming
    // either would move an owned account between items or persist an
    // arbitrary institution string (neither column carries a foreign key).
    // `create_manual_account` is the sole writer of both: the mint route is
    // the only surface that can create or reparent.
    row.shift_remove("institution_id");
    row.shift_remove("item_id");
    row
}

/// Updates each of the user's accounts, reporting one result per account:
/// 304 when there is no such live account or nothing to set, 500 when the
/// write fails (which is logged).
pub async fn update_accounts(user: &MaskedUser, accounts: &[PartialAccount]) -> Vec<UpsertResult> {
    let mut results = Vec::new();

    for account in accounts {
        let account_id = account.get("account_id").map(to_js_string).unwrap_or_default();
        let row = account_update_row(user, account);

        // Soft-deleted rows keep their primary key but are invisible to every
        // read. Updating one would report a change no user can see; excluding
        // them here keeps "update" and "reachable" in agreement.
        let updated = account::TABLE
            .update(
                account.get("account_id").unwrap_or(&Json::Null),
                &row,
                UpdateArgs { user_id: Some(shared_with(user)), exclude_deleted: Some(true), ..Default::default() },
            )
            .await;
        match updated {
            Ok(Some(_)) => results.push(success_result(&account_id, Some(1))),
            Ok(None) => results.push(no_change_result(&account_id)),
            Err(error) => {
                logger::error("Failed to update account", Some(&crate::ctx! { "accountId": account.get("account_id") }), Some(&error));
                results.push(error_result(&account_id));
            }
        }
    }
    results
}

/// Soft-deletes the user's accounts with everything they hold; returns how
/// many accounts were deleted.
pub async fn delete_accounts(user: &MaskedUser, account_ids: &[String]) -> anyhow::Result<u64> {
    if account_ids.is_empty() {
        return Ok(0);
    }

    // All the deletes happen in one transaction: if any fails, none is kept.
    let (user, account_ids) = (user.clone(), account_ids.to_vec());
    with_transaction(|client| Box::pin(async move { soft_delete_accounts(&user, &account_ids, client).await })).await
}

/// The statements of `delete_accounts`, on the transaction's `client`.
async fn soft_delete_accounts(user: &MaskedUser, account_ids: &[String], client: &dyn Executor) -> anyhow::Result<u64> {
    for account_id in account_ids {
        let account = json!(account_id);
        transaction::TABLE.bulk_soft_delete_by_column("account_id", &account, Some(shared_with(user)), Some(client)).await?;
        investment_transaction::TABLE.bulk_soft_delete_by_column("account_id", &account, Some(shared_with(user)), Some(client)).await?;
        split_transaction::TABLE.bulk_soft_delete_by_column("account_id", &account, Some(shared_with(user)), Some(client)).await?;
        // Account-balance snapshots store the account in `account_id`; holding
        // snapshots store it in `holding_account_id` (their `account_id` is NULL).
        // Soft-delete both so deleting an account leaves no orphaned holding history.
        snapshot::TABLE.bulk_soft_delete_by_column("account_id", &account, Some(shared_with(user)), Some(client)).await?;
        snapshot::TABLE.bulk_soft_delete_by_column("holding_account_id", &account, Some(shared_with(user)), Some(client)).await?;
        holding::TABLE.bulk_soft_delete_by_column("account_id", &account, Some(shared_with(user)), Some(client)).await?;
    }

    soft_delete_transaction_pairs_by_accounts(user, account_ids, Some(client)).await?;

    let ids: Vec<Json> = account_ids.iter().map(|account_id| json!(account_id)).collect();
    account::TABLE.bulk_soft_delete(&ids, &[("user_id", shared_with(user))], Some(client)).await
}

#[cfg(test)]
mod tests {
    use super::super::items::testing::{obj, test_user, update_columns_of, updated_tables, FakeExecutor};
    use super::*;
    use crate::server::postgres::database::build_insert;

    // `accounts.test.ts`, "searchAccountsById".

    #[tokio::test]
    async fn search_accounts_by_id_answers_no_ids_without_a_query() {
        assert!(search_accounts_by_id(&test_user(), &[]).await.unwrap().is_empty());
    }

    // `accounts.test.ts`, "upsertAccounts".

    fn account(account_id: &str) -> Obj {
        obj(json!({
            "account_id": account_id,
            "item_id": "item-1",
            "name": "Test Account",
            "type": "depository",
            "balances": { "available": 100, "current": 100, "limit": null, "iso_currency_code": "USD" },
        }))
    }

    #[tokio::test]
    async fn upsert_accounts_answers_no_accounts_without_a_query() {
        let client = FakeExecutor::default();
        assert!(upsert_accounts(&test_user(), &[], Some(&client)).await.is_empty());
        assert!(client.calls().is_empty());
    }

    #[tokio::test]
    async fn upsert_accounts_reports_a_success_per_account() {
        let client = FakeExecutor::default();
        let accounts = [account("acc-1"), account("acc-2"), account("acc-3")];
        let results = upsert_accounts(&test_user(), &accounts, Some(&client)).await;
        let reported: Vec<(&str, u16)> = results.iter().map(|result| (result.id.as_str(), result.status)).collect();
        assert_eq!(reported, [("acc-1", 200), ("acc-2", 200), ("acc-3", 200)]);
        assert_eq!(client.calls().len(), 3);
    }

    #[tokio::test]
    async fn upsert_accounts_reports_an_error_when_the_query_fails() {
        let client = FakeExecutor::failing();
        let results = upsert_accounts(&test_user(), &[account("acc-err")], Some(&client)).await;
        assert_eq!((results[0].id.as_str(), results[0].status), ("acc-err", 500));
    }

    #[tokio::test]
    async fn upsert_accounts_rewrites_every_column_it_was_given() {
        let client = FakeExecutor::default();
        upsert_accounts(&test_user(), &[account("acc-1")], Some(&client)).await;
        let (sql, values) = client.calls().remove(0);
        assert_eq!(
            update_columns_of(&sql),
            [
                "user_id",
                "item_id",
                "name",
                "type",
                "balances_available",
                "balances_current",
                "balances_limit",
                "balances_iso_currency_code",
                "raw",
                "updated",
            ]
        );
        assert_eq!(values[..2], [json!("usr-1"), json!("acc-1")]);
    }

    // `accounts.test.ts`, "createManualAccount".

    fn manual_account_insert(user: &MaskedUser, input: &ManualAccountInput) -> (String, Vec<Json>) {
        let query = build_insert("accounts", &manual_account_row(user, "manual-abc", input), &["*"], false);
        (query.sql, query.values)
    }

    fn manual_input(item_id: &str) -> ManualAccountInput {
        ManualAccountInput { item_id: item_id.to_string(), ..Default::default() }
    }

    #[test]
    fn create_manual_account_issues_an_insert_into_accounts_with_no_on_conflict_clause() {
        let (sql, _) = manual_account_insert(&test_user(), &manual_input("item-1"));
        assert!(sql.starts_with("INSERT INTO accounts "));
        assert!(!sql.contains("ON CONFLICT"));
    }

    #[test]
    fn create_manual_account_binds_the_requesting_users_id_and_the_item_id() {
        let other = MaskedUser { user_id: "usr-99".to_string(), username: "other".to_string() };
        let (_, values) = manual_account_insert(&other, &manual_input("item-x"));
        assert!(values.contains(&json!("usr-99")));
        assert!(values.contains(&json!("item-x")));
    }

    #[test]
    fn create_manual_account_defaults_institution_id_to_the_unknown_sentinel() {
        let (_, values) = manual_account_insert(&test_user(), &manual_input("item-1"));
        assert!(values.contains(&json!("Unknown")));

        let input = ManualAccountInput { institution_id: Some("ins-1".to_string()), ..manual_input("item-1") };
        let row = manual_account_row(&test_user(), "manual-abc", &input);
        assert_eq!(row["institution_id"], json!("ins-1"));
    }

    #[test]
    fn create_manual_account_does_not_write_the_raw_column() {
        let (sql, _) = manual_account_insert(&test_user(), &manual_input("item-1"));
        assert!(!sql.contains("raw"));
    }

    #[test]
    fn a_manual_account_starts_as_an_unnamed_other_account_with_no_balances() {
        let row = manual_account_row(&test_user(), "manual-abc", &manual_input("item-1"));
        assert_eq!(
            crate::js::json_stringify(&Json::Object(row)),
            concat!(
                r#"{"user_id":"usr-1","account_id":"manual-abc","item_id":"item-1","institution_id":"Unknown","#,
                r#""name":"Unknown","type":"other","subtype":null,"balances_available":null,"balances_current":null,"#,
                r#""balances_limit":null,"balances_iso_currency_code":null}"#
            )
        );

        let input = ManualAccountInput { graph_options: Some(json!({ "useTransactions": false })), ..manual_input("item-1") };
        let row = manual_account_row(&test_user(), "manual-abc", &input);
        assert_eq!(row["graph_options_use_transactions"], json!(false));
        assert!(!row.contains_key("graph_options_use_snapshots"));
    }

    // `write-scope.test.ts` relies on `updateAccounts` deleting these from the row.

    #[test]
    fn update_accounts_never_sets_the_key_the_owner_the_item_or_the_institution() {
        let body = obj(json!({
            "account_id": "acc-1",
            "item_id": "item-other",
            "institution_id": "ins-other",
            "custom_name": "Everyday",
            "label": { "budget_id": null },
            "balances": { "current": 5 },
        }));
        let row = account_update_row(&test_user(), &body);
        let columns: Vec<&str> = row.keys().map(|column| column.as_str()).collect();
        assert_eq!(columns, ["custom_name", "label_budget_id", "balances_current", "raw"]);
    }

    // `accounts.test.ts`, "deleteAccounts".

    async fn delete_accounts_statements(account_ids: &[&str]) -> Vec<(String, Vec<Json>)> {
        let client = FakeExecutor::default();
        let account_ids: Vec<String> = account_ids.iter().map(|id| id.to_string()).collect();
        soft_delete_accounts(&test_user(), &account_ids, &client).await.unwrap();
        client.calls()
    }

    #[tokio::test]
    async fn delete_accounts_answers_no_ids_without_a_query() {
        assert_eq!(delete_accounts(&test_user(), &[]).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn delete_accounts_soft_deletes_snapshots_by_both_account_id_and_holding_account_id() {
        // Account-balance snapshots live under `account_id`; holding snapshots
        // live under `holding_account_id` (their `account_id` is NULL). Both
        // passes must fire or the holding-snapshot history is orphaned.
        let calls = delete_accounts_statements(&["acc-del"]).await;
        let snapshot_deletes: Vec<&String> =
            calls.iter().map(|(sql, _)| sql).filter(|sql| sql.starts_with("UPDATE snapshots SET is_deleted")).collect();
        assert!(snapshot_deletes.iter().any(|sql| sql.contains("WHERE account_id = ")));
        assert!(snapshot_deletes.iter().any(|sql| sql.contains("WHERE holding_account_id = ")));
    }

    #[tokio::test]
    async fn delete_accounts_cascades_to_transaction_pairs_on_both_join_columns_once_for_all_accounts() {
        let calls = delete_accounts_statements(&["acc-a", "acc-b"]).await;
        let pair_deletes: Vec<&(String, Vec<Json>)> =
            calls.iter().filter(|(sql, _)| sql.starts_with("UPDATE transaction_pairs")).collect();

        // Hoisted out of the per-account loop: two statements in all, not two
        // per account, with every account id in one `= ANY($1)`.
        assert_eq!(pair_deletes.len(), 2);
        for (sql, values) in &pair_deletes {
            assert!(sql.contains("SELECT transaction_id FROM transactions WHERE account_id = ANY($1))"));
            assert!(sql.contains("AND user_id = ANY(sharing_user_ids($2))"));
            // The `updated` bump is what lets a delta sync deliver the tombstone.
            assert!(sql.contains("SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP"));
            assert_eq!(values, &vec![json!(["acc-a", "acc-b"]), json!("usr-1")]);
        }
        assert!(pair_deletes.iter().any(|(sql, _)| sql.contains("WHERE transaction_id_a IN (SELECT")));
        assert!(pair_deletes.iter().any(|(sql, _)| sql.contains("WHERE transaction_id_b IN (SELECT")));
    }

    #[tokio::test]
    async fn delete_accounts_writes_every_table_of_the_cascade_per_account_then_the_pairs_then_the_accounts() {
        let calls = delete_accounts_statements(&["acc-a", "acc-b"]).await;
        let statements: Vec<String> = calls.iter().map(|(sql, _)| sql.clone()).collect();
        let per_account = ["transactions", "investment_transactions", "split_transactions", "snapshots", "snapshots", "holdings"];
        let mut expected: Vec<&str> = per_account.iter().chain(per_account.iter()).copied().collect();
        expected.extend(["transaction_pairs", "transaction_pairs", "accounts"]);
        assert_eq!(updated_tables(&statements), expected);

        // Each per-account statement names one account and the owner.
        assert_eq!(calls[0].1, vec![json!("acc-a"), json!("usr-1")]);
        assert_eq!(calls[6].1, vec![json!("acc-b"), json!("usr-1")]);
        let (sql, values) = calls.last().unwrap();
        assert_eq!(
            sql,
            "UPDATE accounts SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE account_id IN ($1, $2) AND user_id = ANY(sharing_user_ids($3)) RETURNING account_id"
        );
        assert_eq!(values, &vec![json!("acc-a"), json!("acc-b"), json!("usr-1")]);
    }

    #[tokio::test]
    async fn delete_accounts_runs_the_pairs_cascade_after_the_transactions_soft_delete() {
        let calls = delete_accounts_statements(&["acc-del"]).await;
        let position = |prefix: &str| calls.iter().position(|(sql, _)| sql.starts_with(prefix)).unwrap();
        assert!(position("UPDATE transactions SET is_deleted") < position("UPDATE transaction_pairs"));
    }
}
