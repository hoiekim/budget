//! `src/server/lib/postgres/repositories/transactions.ts`.

use std::collections::HashSet;

use futures::stream::BoxStream;
use futures::StreamExt;
use serde_json::json;

use super::budgets::{get_owned_label_ids, LabelIds};
use crate::filters;
use crate::js::{number_to_string, to_js_string, truthy, Json, JsDate, Obj};
use crate::server::logger;
use crate::server::postgres::client::{pool, Executor};
use crate::server::postgres::database::{
    error_result, no_change_result, refused_result, success_result, DateRange, Filters, QueryData, SearchFilters, UpsertResult,
};
use crate::server::postgres::models::{
    investment_transaction, split_transaction, transaction, transaction_pair, MaskedUser, Row, UpdateArgs, STREAM_BATCH_SIZE,
};

#[derive(Clone, Debug, Default)]
pub struct SearchTransactionsOptions {
    pub account_id: Option<String>,
    /// Declared by the TypeScript options too, and read by no query there either.
    pub account_ids: Option<Vec<String>>,
    /// Bounds `updated`, not `date`: a search by dates is a delta read.
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    /// Applies to transactions only; investment transactions are never pending.
    pub pending: Option<bool>,
    /// When true, soft-deleted (`is_deleted = TRUE`) rows are INCLUDED in
    /// the response so the client can treat them as tombstones and evict
    /// them from its local cache (IDB + in-memory dict). Defaults to
    /// `false`: consumers that filter to active-only rows (the engine,
    /// the sync-plaid delta computation) keep their previous behavior.
    pub include_deleted: bool,
}

/// A (partial) `JSONTransaction` that names its `transaction_id`.
pub type PartialTransaction = Obj;

/// What a delete reports: how many rows it soft-deleted.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Deleted {
    pub deleted: u64,
}

impl Deleted {
    pub fn to_json(&self) -> Json {
        json!({ "deleted": self.deleted })
    }
}

/// A row's id as an `UpsertResult` carries it. The callers hand over ids
/// that are strings; any other value is written as `String(value)`, and
/// one that is missing as the empty string.
pub(super) fn id_of(tx: &Obj, key: &str) -> String {
    match tx.get(key) {
        Some(Json::String(id)) => id.clone(),
        Some(other) => to_js_string(other),
        None => String::new(),
    }
}

/// `{ [name]: tx[key] }` as a logging context: empty when the row has no such id.
pub(super) fn id_context(name: &str, tx: &Obj, key: &str) -> Obj {
    let mut context = Obj::new();
    if let Some(id) = tx.get(key) {
        context.insert(name.to_string(), id.clone());
    }
    context
}

/// `start || end ? { column, start, end } : undefined`.
pub(super) fn date_range(column: &str, start: Option<&str>, end: Option<&str>) -> Option<DateRange> {
    let given = |bound: Option<&str>| bound.is_some_and(|text| !text.is_empty());
    (given(start) || given(end)).then(|| DateRange {
        column: column.to_string(),
        start: start.map(str::to_string),
        end: end.map(str::to_string),
    })
}

/// `new Date().toISOString().split("T")[0]`: today's date in UTC.
pub(super) fn utc_today() -> String {
    let now = JsDate::now().to_iso_string().unwrap_or_default();
    now.split('T').next().unwrap_or_default().to_string()
}

/// One past the highest `Unknown_N` a `MAX(…) AS max` row reports; 1 when
/// the row is missing or its `max` is not a finite number.
pub(super) fn next_unknown_index(row: Option<&Obj>) -> f64 {
    let current_max = row.and_then(|row| row.get("max")).and_then(|max| max.as_f64()).unwrap_or(0.0);
    (if current_max.is_finite() { current_max } else { 0.0 }) + 1.0
}

fn ids_of(ids: &[String]) -> Vec<Json> {
    ids.iter().map(|id| json!(id)).collect()
}

pub async fn get_transaction(user: &MaskedUser, transaction_id: &str) -> anyhow::Result<Option<Json>> {
    let model = transaction::TABLE
        .query_one(filters! { "user_id" => user.user_id.as_str(), "transaction_id" => transaction_id })
        .await?;
    Ok(model.map(|row| transaction::to_json(&row)))
}

/// The two streams `search_transactions` returns, each yielding one batch of JSON rows at a time.
pub struct TransactionBatches {
    pub transactions: BoxStream<'static, anyhow::Result<Vec<Json>>>,
    pub investment_transactions: BoxStream<'static, anyhow::Result<Vec<Json>>>,
}

/// `toJSONBatches` of `models/base.ts`: every batch of rows as its models' JSON.
fn to_json_batches(
    batches: BoxStream<'static, anyhow::Result<Vec<Row>>>,
    to_json: fn(&Row) -> Json,
) -> BoxStream<'static, anyhow::Result<Vec<Json>>> {
    batches.map(move |models| models.map(|models| models.iter().map(to_json).collect())).boxed()
}

fn search_query_options(options: &SearchTransactionsOptions) -> SearchFilters {
    SearchFilters {
        date_range: date_range("updated", options.start_date.as_deref(), options.end_date.as_deref()),
        exclude_deleted: Some(!options.include_deleted),
        ..Default::default()
    }
}

/// `{ user_id, account_id }`: what both reads of a search filter by.
fn search_investment_transaction_filters(user: &MaskedUser, options: &SearchTransactionsOptions) -> Filters {
    let mut filters = filters! { "user_id" => user.user_id.as_str() };
    if let Some(account_id) = &options.account_id {
        filters.extend(filters! { "account_id" => account_id.as_str() });
    }
    filters
}

/// `{ user_id, account_id, pending }`: only transactions are ever pending.
fn search_transaction_filters(user: &MaskedUser, options: &SearchTransactionsOptions) -> Filters {
    let mut filters = search_investment_transaction_filters(user, options);
    if let Some(pending) = options.pending {
        filters.extend(filters! { "pending" => pending });
    }
    filters
}

/// The user's transactions and investment transactions in primary-key order,
/// read and yielded one batch at a time. Nothing is queried until the caller
/// starts reading a stream.
pub fn search_transactions(user: &MaskedUser, options: &SearchTransactionsOptions) -> TransactionBatches {
    let query_options = search_query_options(options);
    let transactions =
        transaction::TABLE.query_in_batches(search_transaction_filters(user, options), query_options.clone(), STREAM_BATCH_SIZE);
    let investment_transactions = investment_transaction::TABLE.query_in_batches(
        search_investment_transaction_filters(user, options),
        query_options,
        STREAM_BATCH_SIZE,
    );
    TransactionBatches {
        transactions: to_json_batches(transactions, transaction::to_json),
        investment_transactions: to_json_batches(investment_transactions, investment_transaction::to_json),
    }
}

pub async fn search_transactions_by_id(user: &MaskedUser, transaction_ids: &[String]) -> anyhow::Result<Vec<Json>> {
    if transaction_ids.is_empty() {
        return Ok(Vec::new());
    }
    let models = transaction::TABLE.query_by_ids(&ids_of(transaction_ids), &[("user_id", json!(user.user_id))]).await?;
    Ok(models.iter().map(transaction::to_json).collect())
}

/// Never fails: a transaction that cannot be written is logged and reported with status 500.
pub async fn upsert_transactions(user: &MaskedUser, transactions: &[Obj], client: Option<&dyn Executor>) -> Vec<UpsertResult> {
    let mut results = Vec::new();
    for tx in transactions {
        let id = id_of(tx, "transaction_id");
        let row = transaction::from_json(tx, &user.user_id);
        match transaction::TABLE.upsert(&row, None, client).await {
            Ok(_) => results.push(success_result(&id, Some(1))),
            Err(error) => {
                logger::error("Failed to upsert transaction", Some(&id_context("transactionId", tx, "transaction_id")), Some(&error));
                results.push(error_result(&id));
            }
        }
    }
    results
}

/// The ids, under `label[key]`, the transactions name: the strings that are not empty.
fn label_ids(transactions: &[PartialTransaction], key: &str) -> Vec<String> {
    transactions
        .iter()
        .filter_map(|tx| tx.get("label")?.get(key)?.as_str())
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .collect()
}

/// Whether the transaction's label names a budget or a category outside the owned ones.
fn names_unowned_label(tx: &PartialTransaction, budget_ids: &HashSet<String>, category_ids: &HashSet<String>) -> bool {
    let label = tx.get("label");
    let unowned = |key: &str, owned: &HashSet<String>| match label.and_then(|label| label.get(key)) {
        Some(id) if truthy(id) => !id.as_str().is_some_and(|id| owned.contains(id)),
        _ => false,
    };
    unowned("budget_id", budget_ids) || unowned("category_id", category_ids)
}

/// The columns an update of `tx` sets: never its id, its owner or its account.
fn update_row(tx: &PartialTransaction, user_id: &str) -> QueryData {
    let mut row = transaction::from_json(tx, user_id);
    row.shift_remove("transaction_id");
    row.shift_remove("user_id");
    row.shift_remove("account_id");
    row
}

pub async fn update_transactions(user: &MaskedUser, transactions: &[PartialTransaction]) -> anyhow::Result<Vec<UpsertResult>> {
    if transactions.is_empty() {
        return Ok(Vec::new());
    }
    let mut results = Vec::new();

    let ids = LabelIds { budget_ids: label_ids(transactions, "budget_id"), category_ids: label_ids(transactions, "category_id") };
    let owned = get_owned_label_ids(user, &ids).await?;

    for tx in transactions {
        let id = id_of(tx, "transaction_id");
        if names_unowned_label(tx, &owned.budget_ids, &owned.category_ids) {
            results.push(refused_result(&id));
            continue;
        }
        let row = update_row(tx, &user.user_id);

        // Soft-deleted rows keep their primary key but are invisible to every
        // read. Updating one would report a change no user can see; excluding
        // them here keeps "update" and "reachable" in agreement.
        let updated = transaction::TABLE
            .update(
                tx.get("transaction_id").unwrap_or(&Json::Null),
                &row,
                UpdateArgs { user_id: Some(&user.user_id), exclude_deleted: Some(true), ..Default::default() },
            )
            .await;
        match updated {
            Ok(Some(_)) => results.push(success_result(&id, Some(1))),
            Ok(None) => results.push(no_change_result(&id)),
            Err(error) => {
                logger::error("Failed to update transaction", Some(&id_context("transactionId", tx, "transaction_id")), Some(&error));
                results.push(error_result(&id));
            }
        }
    }
    Ok(results)
}

/// Queries the highest `Unknown_N` name for the user on `transactions` and
/// returns `N + 1`: the shell mint gets a spot-in-the-list identifier the
/// user can recognize and clean up later. Soft-deleted rows count too so a
/// later undelete can't collide.
async fn next_unknown_tx_index(user_id: &str) -> anyhow::Result<f64> {
    let sql = "SELECT COALESCE(MAX(CAST(SUBSTRING(name FROM '^Unknown_(\\d+)$') AS INTEGER)), 0) AS max \
               FROM transactions WHERE user_id = $1 AND name ~ '^Unknown_[0-9]+$'";
    let result = pool().query(sql, &[json!(user_id)]).await?;
    Ok(next_unknown_index(result.rows.first()))
}

#[derive(Clone, Debug, Default)]
pub struct CreateManualTransactionInput {
    pub account_id: String,
    pub iso_currency_code: Option<String>,
}

fn manual_transaction_row(
    user_id: &str,
    input: &CreateManualTransactionInput,
    transaction_id: &str,
    index: f64,
    date: &str,
) -> QueryData {
    let mut tx = Obj::new();
    tx.insert("transaction_id".into(), json!(transaction_id));
    tx.insert("account_id".into(), json!(input.account_id));
    tx.insert("name".into(), json!(format!("Unknown_{}", number_to_string(index))));
    tx.insert("amount".into(), json!(0));
    tx.insert("iso_currency_code".into(), json!(input.iso_currency_code));
    tx.insert("date".into(), json!(date));
    tx.insert("pending".into(), json!(false));
    tx.insert("source".into(), json!("manual"));
    transaction::from_json(&tx, user_id)
}

/// Inserts a shell `transactions` row for the user to fill in on the
/// detail page. Callers gate `account_id` on `items.provider === MANUAL`
/// so we don't accidentally create a duplicate manual row against a
/// Plaid-synced account. `None` when the row could not be written.
pub async fn create_manual_transaction(user: &MaskedUser, input: &CreateManualTransactionInput) -> anyhow::Result<Option<Json>> {
    let transaction_id = format!("manual-{}", uuid::Uuid::new_v4());
    let index = next_unknown_tx_index(&user.user_id).await?;
    let row = manual_transaction_row(&user.user_id, input, &transaction_id, index, &utc_today());
    let created = async {
        let Some(result) = transaction::TABLE.insert(&row, Some(&["*"]), false).await? else { return Ok(None) };
        anyhow::Ok(Some(transaction::to_json(&transaction::TABLE.validate(result)?)))
    };
    match created.await {
        Ok(created) => Ok(created),
        Err(error) => {
            logger::error(
                "Failed to create manual transaction",
                Some(&crate::ctx! { "transaction_id": transaction_id, "account_id": input.account_id }),
                Some(&error),
            );
            Ok(None)
        }
    }
}

/// Soft-deletes every pair that references a transaction on one of `account_ids`.
///
/// A pair joins `transactions` by id, so a cascade that only knows accounts has
/// to travel through them. Left live, the surviving half stays bundled as a
/// transfer to an account that no longer exists, the detection engine treats it
/// as already-paired and will not re-suggest it, and an untouched `updated`
/// keeps any delta sync from correcting the client.
///
/// Call this AFTER the caller's `transactions` soft-delete: that UPDATE holds an
/// exclusive row lock until commit, which is what blocks a concurrent
/// `pair_transactions`, whose existence pre-check takes `FOR SHARE` on the same
/// rows, from minting a pair behind the cascade.
///
/// Both join columns, one statement each, whatever the account count.
pub async fn soft_delete_transaction_pairs_by_accounts(
    user: &MaskedUser,
    account_ids: &[String],
    client: Option<&dyn Executor>,
) -> anyhow::Result<()> {
    let match_values = ids_of(account_ids);
    for column in ["transaction_id_a", "transaction_id_b"] {
        transaction_pair::TABLE
            .bulk_soft_delete_by_related_column(
                column,
                transaction::TABLE.name,
                "transaction_id",
                "account_id",
                &match_values,
                Some(&user.user_id),
                client,
            )
            .await?;
    }
    Ok(())
}

pub async fn delete_transactions(user: &MaskedUser, transaction_ids: &[String], client: Option<&dyn Executor>) -> anyhow::Result<Deleted> {
    if transaction_ids.is_empty() {
        return Ok(Deleted { deleted: 0 });
    }
    let ids = ids_of(transaction_ids);
    let any_of_ids = Json::Array(ids.clone());

    // Soft-delete splits attached to each transaction (existing cascade).
    split_transaction::TABLE.bulk_soft_delete_by_column("transaction_id", &any_of_ids, Some(&user.user_id), client).await?;

    // Cascade to transaction_pairs: a pair that references any soft-deleted
    // transaction must itself be soft-deleted, otherwise the surviving
    // counterpart stays "stuck" paired with a ghost: the engine sees it
    // as already-paired and refuses to suggest a new candidate. Plaid
    // pending+settled duplicates hit this path. Two UPDATEs per cascade
    // (one per join column) instead of 2N for N transactions.
    transaction_pair::TABLE.bulk_soft_delete_by_column("transaction_id_a", &any_of_ids, Some(&user.user_id), client).await?;
    transaction_pair::TABLE.bulk_soft_delete_by_column("transaction_id_b", &any_of_ids, Some(&user.user_id), client).await?;

    let deleted = transaction::TABLE.bulk_soft_delete(&ids, &[("user_id", json!(user.user_id))], client).await?;
    Ok(Deleted { deleted })
}

/// The dates a search by account is bounded to: `range?: { start?: Date; end?: Date }`.
#[derive(Clone, Copy, Debug, Default)]
pub struct TransactionDateRange {
    pub start: Option<JsDate>,
    pub end: Option<JsDate>,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SearchTransactionsByAccountIdOptions {
    pub include_deleted: bool,
}

/// What `search_transactions_by_account_id` returns.
#[derive(Clone, Debug, Default)]
pub struct AccountTransactions {
    pub transactions: Vec<Json>,
    pub investment_transactions: Vec<Json>,
}

impl AccountTransactions {
    pub fn to_json(&self) -> Json {
        json!({ "transactions": self.transactions, "investment_transactions": self.investment_transactions })
    }
}

/// A `Date` bound as the query takes it: its UTC day,
/// `toISOString().split("T")[0]`. An invalid date goes to the database as
/// the text the Bun driver writes for one, and the database refuses it.
fn date_bound(date: JsDate) -> String {
    match date.to_iso_string() {
        Some(iso) => iso.split('T').next().unwrap_or_default().to_string(),
        None => "Invalid Date".to_string(),
    }
}

pub async fn search_transactions_by_account_id(
    user: &MaskedUser,
    account_ids: &[String],
    range: &TransactionDateRange,
    options: &SearchTransactionsByAccountIdOptions,
) -> anyhow::Result<AccountTransactions> {
    search_transactions_by_account_id_on(pool(), user, account_ids, range, options).await
}

/// The search on a given executor: the pool, or a test's stand-in for it.
async fn search_transactions_by_account_id_on(
    executor: &dyn Executor,
    user: &MaskedUser,
    account_ids: &[String],
    range: &TransactionDateRange,
    options: &SearchTransactionsByAccountIdOptions,
) -> anyhow::Result<AccountTransactions> {
    if account_ids.is_empty() {
        return Ok(AccountTransactions::default());
    }

    let date_range = if range.start.is_some() || range.end.is_some() {
        Some(DateRange {
            column: "date".to_string(),
            start: range.start.map(date_bound),
            end: range.end.map(date_bound),
        })
    } else {
        None
    };

    let query_options = SearchFilters {
        in_filters: vec![("account_id".to_string(), ids_of(account_ids))],
        date_range,
        order_by: Some("date DESC".to_string()),
        exclude_deleted: Some(!options.include_deleted),
        ..Default::default()
    };

    // Both reads are issued and run to their end, as under `Promise.all`,
    // whether or not the other fails.
    let (tx_models, inv_models) = futures::join!(
        transaction::TABLE.query(filters! { "user_id" => user.user_id.as_str() }, query_options.clone(), Some(executor)),
        investment_transaction::TABLE.query(filters! { "user_id" => user.user_id.as_str() }, query_options, Some(executor)),
    );

    Ok(AccountTransactions {
        transactions: tx_models?.iter().map(transaction::to_json).collect(),
        investment_transactions: inv_models?.iter().map(investment_transaction::to_json).collect(),
    })
}

/// What the repositories' tests share.
#[cfg(test)]
pub(super) mod testing {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use async_trait::async_trait;

    use crate::js::{Json, Obj};
    use crate::server::postgres::client::{Executor, QueryResult};
    use crate::server::postgres::models::MaskedUser;

    pub fn user(user_id: &str) -> MaskedUser {
        MaskedUser { user_id: user_id.to_string(), username: "hoie".to_string() }
    }

    /// The object a `json!` literal wrote.
    pub fn obj(value: Json) -> Obj {
        match value {
            Json::Object(map) => map,
            other => panic!("not an object: {other}"),
        }
    }

    enum Answer {
        Result { rows: Vec<Obj>, row_count: u64 },
        Failure(&'static str),
    }

    /// An executor that records each statement and answers the statements in
    /// the order they arrive with what the test scripted; with nothing left
    /// scripted, with no rows and a row count of 0.
    #[derive(Default)]
    pub struct FakeExecutor {
        calls: Mutex<Vec<(String, Vec<Json>)>>,
        answers: Mutex<VecDeque<Answer>>,
    }

    impl FakeExecutor {
        pub fn new() -> Self {
            FakeExecutor::default()
        }

        fn script(self, answer: Answer) -> Self {
            self.answers.lock().unwrap().push_back(answer);
            self
        }

        /// The next statement resolves to these rows, counted.
        pub fn rows(self, rows: Vec<Json>) -> Self {
            let rows: Vec<Obj> = rows.into_iter().map(obj).collect();
            let row_count = rows.len() as u64;
            self.script(Answer::Result { rows, row_count })
        }

        /// The next statement resolves to no rows and this row count.
        pub fn count(self, row_count: u64) -> Self {
            self.script(Answer::Result { rows: Vec::new(), row_count })
        }

        /// The next statement fails with this message.
        pub fn failure(self, message: &'static str) -> Self {
            self.script(Answer::Failure(message))
        }

        /// Every `(sql, values)` queried so far.
        pub fn calls(&self) -> Vec<(String, Vec<Json>)> {
            self.calls.lock().unwrap().clone()
        }

        pub fn sql(&self, index: usize) -> String {
            self.calls()[index].0.clone()
        }

        pub fn values(&self, index: usize) -> Vec<Json> {
            self.calls()[index].1.clone()
        }
    }

    #[async_trait]
    impl Executor for FakeExecutor {
        async fn query(&self, text: &str, values: &[Json]) -> anyhow::Result<QueryResult> {
            self.calls.lock().unwrap().push((text.to_string(), values.to_vec()));
            match self.answers.lock().unwrap().pop_front() {
                Some(Answer::Result { rows, row_count }) => Ok(QueryResult { rows, row_count: Some(row_count) }),
                Some(Answer::Failure(message)) => Err(anyhow::anyhow!(message)),
                None => Ok(QueryResult { rows: Vec::new(), row_count: Some(0) }),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use regex::Regex;
    use serde_json::json;

    use super::testing::{obj, user, FakeExecutor};
    use super::*;
    use crate::server::postgres::database::{build_select_with_filters, build_update, UpdateOptions};

    fn tx_row(overrides: Json) -> Json {
        let mut row = obj(json!({
            "transaction_id": "tx-1",
            "user_id": "usr-1",
            "account_id": "acc-1",
            "name": "Coffee Shop",
            "merchant_name": "Starbucks",
            "amount": 5.5,
            "iso_currency_code": "USD",
            "date": "2026-03-01",
            "pending": false,
            "pending_transaction_id": null,
            "payment_channel": "in store",
            "location_country": null,
            "location_region": null,
            "location_city": null,
            "label_budget_id": null,
            "label_category_id": null,
            "label_memo": null,
            "label_category_confidence": null,
            "raw": null,
            "updated": "2026-03-01T00:00:00Z",
            "is_deleted": false,
            "source": "plaid",
        }));
        row.extend(obj(overrides));
        Json::Object(row)
    }

    /// The first statement each of the two streams of `search_transactions` reads with.
    fn search_queries(user_id: &str, options: &SearchTransactionsOptions) -> [(String, Vec<Json>); 2] {
        let user = user(user_id);
        let first_batch = |table: &str, primary_key: &str, filters: Filters| {
            let options = SearchFilters {
                filters,
                order_by: Some(primary_key.to_string()),
                limit: Some(STREAM_BATCH_SIZE as i64),
                ..search_query_options(options)
            };
            let query = build_select_with_filters(table, "*", &options);
            (query.sql, query.values)
        };
        [
            first_batch("transactions", "transaction_id", search_transaction_filters(&user, options)),
            first_batch("investment_transactions", "investment_transaction_id", search_investment_transaction_filters(&user, options)),
        ]
    }

    // "searchTransactions"

    #[test]
    fn scopes_both_the_transactions_and_the_investment_transactions_read_to_the_user() {
        let [(tx_sql, tx_values), (inv_sql, inv_values)] = search_queries("usr-99", &SearchTransactionsOptions::default());
        assert!(tx_sql.starts_with("SELECT * FROM transactions WHERE user_id = $1"));
        assert!(inv_sql.starts_with("SELECT * FROM investment_transactions WHERE user_id = $1"));
        assert_eq!(tx_values[0], json!("usr-99"));
        assert_eq!(inv_values[0], json!("usr-99"));
    }

    #[test]
    fn a_delta_read_bounds_rows_by_when_they_changed_not_by_their_date() {
        let options = SearchTransactionsOptions { start_date: Some("2026-10-01T00:00:00.000Z".into()), ..Default::default() };
        let date_bound = Regex::new(r"\bdate >= ").unwrap();
        for (sql, values) in search_queries("usr-1", &options) {
            assert!(sql.contains("updated >= $"));
            assert!(!date_bound.is_match(&sql));
            assert!(values.contains(&json!("2026-10-01T00:00:00.000Z")));
        }
    }

    #[test]
    fn soft_deleted_rows_are_included_only_when_asked_for_as_tombstones() {
        let with_tombstones = SearchTransactionsOptions { include_deleted: true, ..Default::default() };
        for (sql, _) in search_queries("usr-1", &with_tombstones) {
            assert!(!sql.contains("is_deleted"));
        }
        for (sql, _) in search_queries("usr-1", &SearchTransactionsOptions::default()) {
            assert!(sql.contains("is_deleted"));
        }
    }

    #[test]
    fn narrows_both_reads_to_an_account_when_one_is_given() {
        let options = SearchTransactionsOptions { account_id: Some("acc-specific".into()), ..Default::default() };
        for (_, values) in search_queries("usr-1", &options) {
            assert!(values.contains(&json!("acc-specific")));
        }
    }

    #[test]
    fn only_the_transactions_read_takes_the_pending_filter() {
        let options = SearchTransactionsOptions { pending: Some(false), end_date: Some("2026-11-01".into()), ..Default::default() };
        let [(tx_sql, tx_values), (inv_sql, inv_values)] = search_queries("usr-1", &options);
        assert_eq!(
            tx_sql,
            "SELECT * FROM transactions WHERE user_id = $1 AND pending = $2 AND updated <= $3 AND (is_deleted IS NULL OR is_deleted = FALSE) ORDER BY transaction_id LIMIT $4"
        );
        assert_eq!(tx_values, vec![json!("usr-1"), json!(false), json!("2026-11-01"), json!(500)]);
        assert_eq!(
            inv_sql,
            "SELECT * FROM investment_transactions WHERE user_id = $1 AND updated <= $2 AND (is_deleted IS NULL OR is_deleted = FALSE) ORDER BY investment_transaction_id LIMIT $3"
        );
        assert_eq!(inv_values, vec![json!("usr-1"), json!("2026-11-01"), json!(500)]);
    }

    // Building the streams needs neither a runtime nor a database: reading them does.
    #[test]
    fn nothing_is_queried_until_the_batches_are_read() {
        let batches = search_transactions(&user("usr-1"), &SearchTransactionsOptions::default());
        drop(batches);
    }

    #[test]
    fn a_date_range_needs_a_bound_that_is_not_empty() {
        assert!(date_range("updated", None, None).is_none());
        assert!(date_range("updated", Some(""), Some("")).is_none());
        let range = date_range("updated", Some(""), Some("2026-04-01")).unwrap();
        assert_eq!((range.column.as_str(), range.start.as_deref(), range.end.as_deref()), ("updated", Some(""), Some("2026-04-01")));
    }

    // "searchTransactionsById"

    #[tokio::test]
    async fn search_by_id_returns_empty_array_for_empty_input() {
        assert!(search_transactions_by_id(&user("usr-1"), &[]).await.unwrap().is_empty());
    }

    // "searchTransactionsByAccountId"

    async fn search_by_account(executor: &FakeExecutor, options: SearchTransactionsByAccountIdOptions) -> AccountTransactions {
        search_transactions_by_account_id_on(executor, &user("usr-1"), &["acc-1".to_string()], &TransactionDateRange::default(), &options)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn search_by_account_defaults_to_active_only() {
        // Two queries: one for transactions, one for investment_transactions.
        let executor = FakeExecutor::new();
        search_by_account(&executor, SearchTransactionsByAccountIdOptions::default()).await;
        assert_eq!(executor.calls().len(), 2);
        assert_eq!(
            executor.sql(0),
            "SELECT * FROM transactions WHERE user_id = $1 AND account_id IN ($2) AND (is_deleted IS NULL OR is_deleted = FALSE) ORDER BY date DESC"
        );
        assert_eq!(
            executor.sql(1),
            "SELECT * FROM investment_transactions WHERE user_id = $1 AND account_id IN ($2) AND (is_deleted IS NULL OR is_deleted = FALSE) ORDER BY date DESC"
        );
        assert_eq!(executor.values(0), vec![json!("usr-1"), json!("acc-1")]);
    }

    #[tokio::test]
    async fn search_by_account_with_include_deleted_drops_the_soft_delete_predicate_on_both_arms() {
        let executor = FakeExecutor::new();
        search_by_account(&executor, SearchTransactionsByAccountIdOptions { include_deleted: true }).await;
        assert!(!executor.sql(0).contains("is_deleted IS NULL OR is_deleted = FALSE"));
        assert!(!executor.sql(1).contains("is_deleted IS NULL OR is_deleted = FALSE"));
    }

    #[tokio::test]
    async fn search_by_account_returns_deleted_rows_when_include_deleted() {
        let executor = FakeExecutor::new().rows(vec![tx_row(json!({ "transaction_id": "tx-deleted", "is_deleted": true }))]);
        let result = search_by_account(&executor, SearchTransactionsByAccountIdOptions { include_deleted: true }).await;
        assert_eq!(result.transactions.len(), 1);
        assert_eq!(result.transactions[0]["transaction_id"], json!("tx-deleted"));
        assert_eq!(result.transactions[0]["is_deleted"], json!(true));
        assert!(result.investment_transactions.is_empty());
    }

    #[tokio::test]
    async fn search_by_account_short_circuits_on_empty_account_ids_without_touching_the_db() {
        let executor = FakeExecutor::new();
        let result = search_transactions_by_account_id_on(
            &executor,
            &user("usr-1"),
            &[],
            &TransactionDateRange::default(),
            &SearchTransactionsByAccountIdOptions::default(),
        )
        .await
        .unwrap();
        assert_eq!(crate::js::json_stringify(&result.to_json()), r#"{"transactions":[],"investment_transactions":[]}"#);
        assert!(executor.calls().is_empty());
    }

    #[tokio::test]
    async fn search_by_account_bounds_the_date_by_the_utc_day_of_each_end_of_the_range() {
        let executor = FakeExecutor::new();
        let range = TransactionDateRange {
            start: Some(JsDate::parse("2026-01-31T23:30:00-08:00")),
            end: Some(JsDate::parse("2026-03-01T00:00:00Z")),
        };
        let accounts = ["acc-1".to_string(), "acc-2".to_string()];
        search_transactions_by_account_id_on(&executor, &user("usr-1"), &accounts, &range, &Default::default()).await.unwrap();
        assert_eq!(
            executor.sql(0),
            "SELECT * FROM transactions WHERE user_id = $1 AND account_id IN ($2, $3) AND date >= $4 AND date <= $5 AND (is_deleted IS NULL OR is_deleted = FALSE) ORDER BY date DESC"
        );
        assert_eq!(
            executor.values(1),
            vec![json!("usr-1"), json!("acc-1"), json!("acc-2"), json!("2026-02-01"), json!("2026-03-01")]
        );

        // One end alone bounds that side only; a date that is not one is left for the database to refuse.
        let executor = FakeExecutor::new();
        let range = TransactionDateRange { start: None, end: Some(JsDate::INVALID) };
        search_transactions_by_account_id_on(&executor, &user("usr-1"), &accounts[..1], &range, &Default::default()).await.unwrap();
        assert_eq!(
            executor.sql(0),
            "SELECT * FROM transactions WHERE user_id = $1 AND account_id IN ($2) AND date <= $3 AND (is_deleted IS NULL OR is_deleted = FALSE) ORDER BY date DESC"
        );
        assert_eq!(executor.values(0), vec![json!("usr-1"), json!("acc-1"), json!("Invalid Date")]);
    }

    // "upsertTransactions"

    #[tokio::test]
    async fn upsert_returns_empty_array_for_empty_input() {
        let executor = FakeExecutor::new();
        assert!(upsert_transactions(&user("usr-1"), &[], Some(&executor)).await.is_empty());
        assert!(executor.calls().is_empty());
    }

    #[tokio::test]
    async fn upsert_returns_an_upsert_result_for_each_transaction() {
        let executor = FakeExecutor::new().rows(vec![json!({ "transaction_id": "tx-1" })]);
        let tx = obj(json!({
            "transaction_id": "tx-1",
            "account_id": "acc-1",
            "name": "Coffee",
            "amount": 5.0,
            "date": "2026-03-01",
            "pending": false,
            "merchant_name": null,
            "iso_currency_code": "USD",
        }));
        let result = upsert_transactions(&user("usr-1"), &[tx], Some(&executor)).await;
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "tx-1");
        assert_eq!(result[0].status, 200);
        assert_eq!(
            executor.sql(0),
            "INSERT INTO transactions (updated, user_id, transaction_id, account_id, name, merchant_name, amount, iso_currency_code, date, pending, raw) \
             VALUES (CURRENT_TIMESTAMP, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) \
             ON CONFLICT (transaction_id) DO UPDATE SET user_id = EXCLUDED.user_id, account_id = EXCLUDED.account_id, name = EXCLUDED.name, \
             merchant_name = EXCLUDED.merchant_name, amount = EXCLUDED.amount, iso_currency_code = EXCLUDED.iso_currency_code, date = EXCLUDED.date, \
             pending = EXCLUDED.pending, raw = EXCLUDED.raw, updated = CURRENT_TIMESTAMP RETURNING *"
        );
    }

    #[tokio::test]
    async fn upsert_returns_an_error_result_on_query_failure_and_carries_on() {
        let executor = FakeExecutor::new().failure("DB error");
        let transactions = [
            obj(json!({ "transaction_id": "tx-bad", "account_id": "acc-1", "name": "Failed", "amount": 1.0, "date": "2026-03-01", "pending": false })),
            obj(json!({ "transaction_id": "tx-good", "account_id": "acc-1", "date": "2026-03-01" })),
        ];
        let result = upsert_transactions(&user("usr-1"), &transactions, Some(&executor)).await;
        assert_eq!((result[0].id.as_str(), result[0].status), ("tx-bad", 500));
        assert_eq!((result[1].id.as_str(), result[1].status), ("tx-good", 200));
        assert_eq!(executor.calls().len(), 2);
    }

    // "updateTransactions"

    /// The UPDATE `update_transactions` builds for `tx`, or `None` when it sets nothing.
    fn update_statement(tx: Json) -> Option<(String, Vec<Json>)> {
        let tx = obj(tx);
        let row = update_row(&tx, "usr-1");
        let options = UpdateOptions {
            additional_where: &[crate::server::postgres::database::AdditionalWhere::new("user_id", "usr-1")],
            returning: &["transaction_id"],
            exclude_deleted: true,
        };
        build_update("transactions", "transaction_id", tx.get("transaction_id").unwrap(), &row, &options).map(|query| (query.sql, query.values))
    }

    fn owned(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    #[tokio::test]
    async fn update_returns_empty_array_for_empty_input() {
        assert!(update_transactions(&user("usr-1"), &[]).await.unwrap().is_empty());
    }

    #[test]
    fn update_preserves_caller_supplied_category_confidence_as_is() {
        let (_, values) = update_statement(json!({ "transaction_id": "tx-2", "label": { "category_id": "cat-2", "category_confidence": 0.0 } })).unwrap();
        assert!(values.contains(&json!(0.0)));
        assert!(!values.contains(&json!(1.0)));
    }

    #[test]
    fn update_does_not_inject_confidence_when_the_caller_omits_it() {
        let (sql, values) = update_statement(json!({ "transaction_id": "tx-1", "label": { "category_id": "cat-1" } })).unwrap();
        assert_eq!(
            sql,
            "UPDATE transactions SET updated = CURRENT_TIMESTAMP, label_category_id = $1 WHERE transaction_id = $2 AND user_id = $3 AND (is_deleted IS NULL OR is_deleted = FALSE) RETURNING transaction_id"
        );
        assert_eq!(values, vec![json!("cat-1"), json!("tx-1"), json!("usr-1")]);
    }

    #[test]
    fn a_label_naming_a_budget_or_category_the_caller_does_not_own_is_refused() {
        let (budgets, categories) = (owned(&["bud-1"]), owned(&["cat-1", "cat-2"]));
        let refused = |label: Json| names_unowned_label(&obj(json!({ "transaction_id": "tx-3", "label": label })), &budgets, &categories);
        assert!(refused(json!({ "category_id": "someone-elses-cat" })));
        assert!(refused(json!({ "budget_id": "someone-elses-budget" })));
        assert!(refused(json!({ "budget_id": "bud-1", "category_id": "no-such-cat" })));
        // An id that is not a string is in no set of owned ids.
        assert!(refused(json!({ "budget_id": 5 })));
        assert!(refused(json!({ "category_id": ["cat-1"] })));

        assert!(!refused(json!({ "budget_id": "bud-1", "category_id": "cat-1" })));
        assert!(!refused(json!({ "category_id": "cat-2" })));
        // Clearing a label, or naming nothing, asks for no one's row.
        assert!(!refused(json!({ "budget_id": null, "category_id": null })));
        assert!(!refused(json!({ "budget_id": "", "category_id": "" })));
        assert!(!refused(json!({ "memo": "lunch" })));
        assert!(!refused(Json::Null));
        assert!(!refused(json!("cat-1")));
        assert!(!names_unowned_label(&obj(json!({ "transaction_id": "tx-3" })), &budgets, &categories));
    }

    #[test]
    fn the_ownership_lookup_asks_about_the_named_ids_only() {
        let transactions = [
            obj(json!({ "transaction_id": "a", "label": { "budget_id": "bud-1", "category_id": "cat-1" } })),
            obj(json!({ "transaction_id": "b", "label": { "budget_id": null, "category_id": "" } })),
            obj(json!({ "transaction_id": "c", "label": { "budget_id": 7, "category_id": "cat-1" } })),
            obj(json!({ "transaction_id": "d", "label": null })),
            obj(json!({ "transaction_id": "e", "label": "bud-9" })),
            obj(json!({ "transaction_id": "f" })),
        ];
        assert_eq!(label_ids(&transactions, "budget_id"), ["bud-1"]);
        assert_eq!(label_ids(&transactions, "category_id"), ["cat-1", "cat-1"]);
    }

    #[test]
    fn an_update_never_moves_a_transaction_to_another_account() {
        let (sql, values) = update_statement(json!({ "transaction_id": "tx-6", "account_id": "someone-elses-account", "name": "renamed" })).unwrap();
        assert!(!Regex::new(r"\baccount_id\s*=").unwrap().is_match(&sql));
        assert!(!values.contains(&json!("someone-elses-account")));
        assert!(values.contains(&json!("renamed")));
    }

    #[test]
    fn an_update_that_names_no_column_is_no_statement() {
        assert!(update_statement(json!({ "transaction_id": "tx-7" })).is_none());
        assert!(update_statement(json!({ "transaction_id": "tx-7", "account_id": "acc-2", "label": {} })).is_none());
    }

    // "createManualTransaction"

    #[test]
    fn a_manual_transaction_starts_as_a_named_zero_amount_shell() {
        let input = CreateManualTransactionInput { account_id: "acc-1".into(), iso_currency_code: None };
        let row = manual_transaction_row("usr-1", &input, "manual-1", 3.0, "2026-11-21");
        assert_eq!(
            crate::js::json_stringify(&Json::Object(row)),
            r#"{"user_id":"usr-1","transaction_id":"manual-1","account_id":"acc-1","name":"Unknown_3","amount":0,"iso_currency_code":null,"date":"2026-11-21","pending":false,"source":"manual","raw":{"transaction_id":"manual-1","account_id":"acc-1","name":"Unknown_3","amount":0,"iso_currency_code":null,"date":"2026-11-21","pending":false}}"#
        );
        let input = CreateManualTransactionInput { account_id: "acc-1".into(), iso_currency_code: Some("KRW".into()) };
        assert_eq!(manual_transaction_row("usr-1", &input, "manual-1", 1.0, "2026-11-21")["iso_currency_code"], json!("KRW"));
    }

    #[test]
    fn the_next_unknown_index_is_one_past_the_highest() {
        assert_eq!(next_unknown_index(Some(&obj(json!({ "max": 0 })))), 1.0);
        assert_eq!(next_unknown_index(Some(&obj(json!({ "max": 41 })))), 42.0);
        assert_eq!(next_unknown_index(Some(&obj(json!({ "max": null })))), 1.0);
        assert_eq!(next_unknown_index(Some(&obj(json!({})))), 1.0);
        assert_eq!(next_unknown_index(None), 1.0);
    }

    #[test]
    fn an_id_is_reported_as_the_text_it_is() {
        let tx = obj(json!({ "transaction_id": "tx-1", "n": 7 }));
        assert_eq!(id_of(&tx, "transaction_id"), "tx-1");
        assert_eq!(id_of(&tx, "n"), "7");
        assert_eq!(id_of(&tx, "absent"), "");
        assert_eq!(crate::js::json_stringify(&Json::Object(id_context("transactionId", &tx, "transaction_id"))), r#"{"transactionId":"tx-1"}"#);
        assert!(id_context("transactionId", &tx, "absent").is_empty());
    }

    // The cascades run on the caller's transaction client, in this order.

    #[tokio::test]
    async fn delete_cascades_to_splits_and_pairs_before_the_transactions() {
        let executor = FakeExecutor::new().count(1).count(0).count(1).count(2);
        let ids = ["tx-1".to_string(), "tx-2".to_string()];
        let result = delete_transactions(&user("usr-1"), &ids, Some(&executor)).await.unwrap();
        assert_eq!(result, Deleted { deleted: 2 });
        let any_of_ids = vec![json!(["tx-1", "tx-2"]), json!("usr-1")];
        assert_eq!(
            executor.calls(),
            vec![
                (
                    "UPDATE split_transactions SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE transaction_id = ANY($1) AND user_id = $2 RETURNING split_transaction_id".to_string(),
                    any_of_ids.clone(),
                ),
                (
                    "UPDATE transaction_pairs SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE transaction_id_a = ANY($1) AND user_id = $2 RETURNING pair_id".to_string(),
                    any_of_ids.clone(),
                ),
                (
                    "UPDATE transaction_pairs SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE transaction_id_b = ANY($1) AND user_id = $2 RETURNING pair_id".to_string(),
                    any_of_ids,
                ),
                (
                    "UPDATE transactions SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE transaction_id IN ($1, $2) AND user_id = $3 RETURNING transaction_id".to_string(),
                    vec![json!("tx-1"), json!("tx-2"), json!("usr-1")],
                ),
            ]
        );
    }

    #[tokio::test]
    async fn delete_with_no_ids_issues_no_statement() {
        let executor = FakeExecutor::new();
        assert_eq!(delete_transactions(&user("usr-1"), &[], Some(&executor)).await.unwrap(), Deleted { deleted: 0 });
        assert!(executor.calls().is_empty());
    }

    #[tokio::test]
    async fn pairs_are_soft_deleted_through_the_transactions_of_the_accounts() {
        let executor = FakeExecutor::new();
        let accounts = ["acc-1".to_string(), "acc-2".to_string()];
        soft_delete_transaction_pairs_by_accounts(&user("usr-1"), &accounts, Some(&executor)).await.unwrap();
        let statement = |column: &str| {
            (
                format!(
                    "UPDATE transaction_pairs SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE {column} IN (SELECT transaction_id FROM transactions WHERE account_id = ANY($1)) AND user_id = $2 RETURNING pair_id"
                ),
                vec![json!(["acc-1", "acc-2"]), json!("usr-1")],
            )
        };
        assert_eq!(executor.calls(), vec![statement("transaction_id_a"), statement("transaction_id_b")]);

        let executor = FakeExecutor::new();
        soft_delete_transaction_pairs_by_accounts(&user("usr-1"), &[], Some(&executor)).await.unwrap();
        assert!(executor.calls().is_empty());
    }
}
