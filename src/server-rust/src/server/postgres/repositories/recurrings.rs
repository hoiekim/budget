//! `src/server/lib/postgres/repositories/recurrings.ts`.

use std::collections::{HashMap, HashSet};
use std::future::Future;

use indexmap::IndexSet;
use serde_json::json;

use crate::common::constants::{RECURRINGS, SPLIT_TRANSACTIONS, TRANSACTIONS};
use crate::common::date::get_date_string;
use crate::filters;
use crate::js::{math_round, num, number_to_string, to_js_string, to_number, truthy, truthy_opt, Json, JsDate, Obj};
use crate::server::postgres::client::{pool, Client, Executor};
use crate::server::postgres::database::{DateRange, SearchFilters};
use crate::server::postgres::models::base::{str_of, value_of};
use crate::server::postgres::models::common::{
    CADENCE, IS_DELETED, IS_INCOME, LABEL_BUDGET_ID, LABEL_CATEGORY_CONFIDENCE, LABEL_CATEGORY_ID, MERCHANT_KEY,
    MERCHANT_NAME, RECURRING_ID, SPLITS, SPLITS_SINCE, STATUS, TRANSACTION_ID, TRANSACTION_IDS, UPDATED, USER_ID,
};
use crate::server::postgres::models::{recurring, transaction, MaskedUser, Row, UpdateArgs};
use crate::server::postgres::repositories::budgets::{get_owned_label_ids, LabelIds};

/// A recurring as the API delivers it, the TypeScript `Recurring`:
/// `{ recurring_id, merchant_key, merchant_name, cadence, is_income, status,
/// transactions, label, splits, updated }`. `transactions` holds its live
/// members as `JSONTransaction`s (none on an eviction signal), `label` is the
/// default `{ budget_id, category_id }` its transactions take while it's
/// confirmed, and `splits` the splits each charge joining it takes. `updated`
/// is bumped on every mutation (confirm/dismiss/create/auto-attach), which
/// lets the client reduce over a delta by `updated` instead of replacing its
/// cache wholesale: the role `updated` plays on transaction pairs.
pub type Recurring = Json;

/// `GetRecurringsOptions`.
#[derive(Clone, Debug, Default)]
pub struct GetRecurringsOptions {
    /// When true, non-renderable recurrings are included as eviction
    /// signals. Defaults to false: a caller that just wants the current list
    /// gets active-non-dismissed rows only.
    pub include_deleted: bool,
    /// Delta cursor. When set (and not empty), only recurrings whose
    /// `updated >= start_date` are returned. Backed by the
    /// `(user_id, updated)` composite index.
    pub start_date: Option<String>,
    /// Restrict to these recurrings: how a write route reads back the row it
    /// just changed so the writing tab can apply it without a refetch. An
    /// empty list restricts nothing.
    pub recurring_ids: Option<Vec<String>>,
}

/// The TypeScript `RecurringResult`: `{ ok: true, recurring_id }` is
/// `Ok { recurring_id }` and `{ ok: false, error }` is `Failed { error }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecurringResult {
    Ok { recurring_id: String },
    Failed { error: String },
}

impl RecurringResult {
    /// The object the TypeScript returns.
    pub fn to_json(&self) -> Json {
        match self {
            RecurringResult::Ok { recurring_id } => json!({ "ok": true, "recurring_id": recurring_id }),
            RecurringResult::Failed { error } => json!({ "ok": false, "error": error }),
        }
    }
}

/// The TypeScript `RecurringConfirmResult`: `{ ok: true }` is `Ok` and
/// `{ ok: false, error }` is `Failed { error }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecurringConfirmResult {
    Ok,
    Failed { error: String },
}

impl RecurringConfirmResult {
    /// The object the TypeScript returns.
    pub fn to_json(&self) -> Json {
        match self {
            RecurringConfirmResult::Ok => json!({ "ok": true }),
            RecurringConfirmResult::Failed { error } => json!({ "ok": false, "error": error }),
        }
    }

    fn not_found() -> Self {
        RecurringConfirmResult::Failed { error: "Recurring not found.".to_string() }
    }
}

/// A recurring is visible to the client only when it's active AND not
/// user-dismissed. `status='dismissed'` is the denylist signal (mirrors
/// transfers' `status='rejected'`): the engine won't re-suggest this
/// merchant group.
fn is_visible(recurring: &Row) -> bool {
    !truthy_opt(recurring.get(IS_DELETED)) && str_of(recurring, STATUS) != "dismissed"
}

/// `recurring.transaction_ids`.
fn transaction_ids_of(recurring: &Row) -> impl Iterator<Item = &str> {
    recurring.get(TRANSACTION_IDS).and_then(|ids| ids.as_array()).into_iter().flatten().filter_map(|id| id.as_str())
}

fn to_recurring(recurring: &Row, transactions: Vec<Json>) -> Recurring {
    let mut label = Obj::new();
    label.insert("budget_id".into(), value_of(recurring, LABEL_BUDGET_ID));
    label.insert("category_id".into(), value_of(recurring, LABEL_CATEGORY_ID));
    let mut out = Obj::new();
    for column in [RECURRING_ID, MERCHANT_KEY, MERCHANT_NAME, CADENCE, IS_INCOME, STATUS] {
        out.insert(column.into(), value_of(recurring, column));
    }
    out.insert("transactions".into(), Json::Array(transactions));
    out.insert("label".into(), Json::Object(label));
    out.insert("splits".into(), value_of(recurring, SPLITS));
    out.insert("updated".into(), value_of(recurring, UPDATED));
    Json::Object(out)
}

/// A recurring the client must drop from its cache.
fn to_eviction(recurring: &Row) -> Recurring {
    to_recurring(recurring, Vec::new())
}

/// The visible recurrings with their live members inline, followed by
/// `evictions`. An active recurring none of whose members resolves any more
/// (all soft-deleted) is left out, and under `include_deleted` it must be
/// evicted explicitly: a delta reducer never revisits an id it isn't sent.
fn resolve_recurrings(
    visible_recurrings: &[&Row],
    txn_by_id: &HashMap<String, Json>,
    include_deleted: bool,
    mut evictions: Vec<Recurring>,
) -> Vec<Recurring> {
    let mut active: Vec<Recurring> = Vec::new();
    for recurring in visible_recurrings {
        let transactions: Vec<Json> = transaction_ids_of(recurring).filter_map(|id| txn_by_id.get(id)).cloned().collect();
        if transactions.is_empty() {
            if include_deleted {
                evictions.push(to_eviction(recurring));
            }
            continue;
        }
        active.push(to_recurring(recurring, transactions));
    }
    active.extend(evictions);
    active
}

/// Get all recurrings for a user. Resolves each recurring's
/// `transaction_ids` to the live transaction JSONs so the response shape
/// stays denormalized (one entry per recurring, members inline): the same
/// contract `get_transfer_pairs` keeps for pairs.
pub async fn get_recurrings(user: &MaskedUser, options: GetRecurringsOptions) -> anyhow::Result<Vec<Recurring>> {
    let all_recurrings = recurring::TABLE
        .query(
            filters! { USER_ID => user.user_id.as_str() },
            SearchFilters {
                order_by: Some(RECURRING_ID.to_string()),
                exclude_deleted: Some(!options.include_deleted),
                in_filters: options
                    .recurring_ids
                    .map(|ids| vec![(RECURRING_ID.to_string(), ids.into_iter().map(Json::String).collect())])
                    .unwrap_or_default(),
                date_range: options
                    .start_date
                    .filter(|start| !start.is_empty())
                    .map(|start| DateRange { column: UPDATED.to_string(), start: Some(start), end: None }),
                ..Default::default()
            },
            None,
        )
        .await?;

    if all_recurrings.is_empty() {
        return Ok(Vec::new());
    }

    let visible_recurrings: Vec<&Row> = all_recurrings.iter().filter(|recurring| is_visible(recurring)).collect();

    let evictions: Vec<Recurring> = if options.include_deleted {
        all_recurrings.iter().filter(|recurring| !is_visible(recurring)).map(to_eviction).collect()
    } else {
        Vec::new()
    };

    if visible_recurrings.is_empty() {
        return Ok(evictions);
    }

    let txn_ids: IndexSet<&str> = visible_recurrings.iter().flat_map(|recurring| transaction_ids_of(recurring)).collect();

    let txn_models = transaction::TABLE
        .query(
            filters! { USER_ID => user.user_id.as_str() },
            SearchFilters {
                in_filters: vec![(TRANSACTION_ID.to_string(), txn_ids.into_iter().map(|id| json!(id)).collect())],
                ..Default::default()
            },
            None,
        )
        .await?;

    let mut txn_by_id: HashMap<String, Json> = HashMap::new();
    for model in &txn_models {
        txn_by_id.insert(str_of(model, TRANSACTION_ID).to_string(), transaction::to_json(model));
    }

    Ok(resolve_recurrings(&visible_recurrings, &txn_by_id, options.include_deleted, evictions))
}

/// A `JSONRecurringLabel`: a default budget and category, each an id or null.
#[derive(Clone, Debug, PartialEq)]
struct Label {
    budget_id: Json,
    category_id: Json,
}

impl Label {
    const EMPTY: Label = Label { budget_id: Json::Null, category_id: Json::Null };

    /// The label two keys of `object` hold; one it lacks counts as null,
    /// which is also what the database is sent for it.
    fn of(object: &Obj, budget_key: &str, category_key: &str) -> Label {
        Label { budget_id: value_of(object, budget_key), category_id: value_of(object, category_key) }
    }

    fn is_empty(&self) -> bool {
        !truthy(&self.budget_id) && !truthy(&self.category_id)
    }

    /// What `label_category_confidence` a transaction given this label gets.
    /// A budget-only default marks the category as deliberately empty (0),
    /// not unlabeled (NULL): the suggestion engine only fills NULL rows, and
    /// its pick would move them to whatever budget its category sits under.
    fn confidence(&self) -> i64 {
        if truthy(&self.category_id) {
            1
        } else {
            0
        }
    }
}

async fn lock_recurrings(client: &dyn Executor, user_id: &str) -> anyhow::Result<()> {
    client.query("SELECT pg_advisory_xact_lock(hashtext($1 || ':recurrings'))", &[json!(user_id)]).await?;
    Ok(())
}

/// Give `transaction_ids` a recurring's default label, skipping exceptions.
/// `previous` is the default they were following before this change. A
/// transaction follows the default when it is:
///   - unlabeled (confidence NULL) or holds an engine suggestion (0 < c < 1);
///   - confirmed (c = 1) with exactly the previous default;
///   - category-less by choice (c = 0, what a budget-only edit or a cleared
///     category leaves) with no budget or the previous default's budget.
///
/// Anything else the user chose (a different confirmed category, a move to
/// another budget) is an exception and keeps its label. An empty default
/// relabels nothing.
async fn apply_recurring_label(
    executor: &dyn Executor,
    user_id: &str,
    label: &Label,
    transaction_ids: &[Json],
    previous: &Label,
) -> anyhow::Result<()> {
    if label.is_empty() || transaction_ids.is_empty() {
        return Ok(());
    }
    executor
        .query(
            &format!(
                "UPDATE {TRANSACTIONS}
     SET {LABEL_BUDGET_ID} = $3::uuid,
         {LABEL_CATEGORY_ID} = $4::uuid,
         {LABEL_CATEGORY_CONFIDENCE} = $5::float,
         {UPDATED} = CURRENT_TIMESTAMP
     WHERE {USER_ID} = $1
       AND {TRANSACTION_ID} = ANY($2::text[])
       AND ({IS_DELETED} IS NULL OR {IS_DELETED} = FALSE)
       AND (
         {LABEL_CATEGORY_CONFIDENCE} IS NULL
         OR ({LABEL_CATEGORY_CONFIDENCE} > 0 AND {LABEL_CATEGORY_CONFIDENCE} < 1)
         OR ({LABEL_CATEGORY_CONFIDENCE} >= 1
             AND {LABEL_BUDGET_ID} IS NOT DISTINCT FROM $6::uuid
             AND {LABEL_CATEGORY_ID} IS NOT DISTINCT FROM $7::uuid)
         OR ({LABEL_CATEGORY_CONFIDENCE} <= 0
             AND ({LABEL_BUDGET_ID} IS NULL OR {LABEL_BUDGET_ID} = $6::uuid))
       )
       AND (
         {LABEL_BUDGET_ID} IS DISTINCT FROM $3::uuid
         OR {LABEL_CATEGORY_ID} IS DISTINCT FROM $4::uuid
         OR {LABEL_CATEGORY_CONFIDENCE} IS DISTINCT FROM $5::float
       )"
            ),
            &[
                json!(user_id),
                Json::Array(transaction_ids.to_vec()),
                label.budget_id.clone(),
                label.category_id.clone(),
                json!(label.confidence()),
                previous.budget_id.clone(),
                previous.category_id.clone(),
            ],
        )
        .await?;
    Ok(())
}

/// The label the user has confirmed most often on these transactions (most
/// recent wins a tie). It's what a recurring starts with when it's confirmed
/// without a default, and what its transactions count as following while it
/// has none.
async fn seed_recurring_label(executor: &dyn Executor, user_id: &str, transaction_ids: &[Json]) -> anyhow::Result<Label> {
    if transaction_ids.is_empty() {
        return Ok(Label::EMPTY);
    }
    let result = executor
        .query(
            &format!(
                "SELECT {LABEL_BUDGET_ID} AS budget_id, {LABEL_CATEGORY_ID} AS category_id
     FROM {TRANSACTIONS}
     WHERE {USER_ID} = $1
       AND {TRANSACTION_ID} = ANY($2::text[])
       AND ({IS_DELETED} IS NULL OR {IS_DELETED} = FALSE)
       AND {LABEL_CATEGORY_CONFIDENCE} = 1
       AND {LABEL_CATEGORY_ID} IS NOT NULL
     GROUP BY {LABEL_BUDGET_ID}, {LABEL_CATEGORY_ID}
     ORDER BY COUNT(*) DESC, MAX(date) DESC
     LIMIT 1"
            ),
            &[json!(user_id), Json::Array(transaction_ids.to_vec())],
        )
        .await?;
    Ok(match result.rows.first() {
        Some(row) => Label::of(row, "budget_id", "category_id"),
        None => Label::EMPTY,
    })
}

/// `split.label.<key>`: one id of a `JSONRecurringSplit`'s label, `None`
/// where the label has no such key. A split without a label is an error.
fn split_label_id<'a>(split: &'a Json, key: &str) -> anyhow::Result<Option<&'a Json>> {
    match split.get("label") {
        None | Some(Json::Null) => anyhow::bail!("A recurring split has no label"),
        Some(label) => Ok(label.get(key)),
    }
}

/// What a recurring's splits take from a charge, in cents exactly:
/// `splits.reduce((sum, s) => sum + s.amount, 0)`, rounded. An amount is a
/// number. One that is not adds the way JavaScript's `+` does, so both
/// servers reach the same total: null as 0, a missing one as NaN, and text
/// turns the sum into text that is read back as a number at the end.
fn splits_total(splits: &[Json]) -> f64 {
    enum Sum {
        Number(f64),
        Text(String),
    }
    let mut sum = Sum::Number(0.0);
    for split in splits {
        sum = match (sum, split.get("amount")) {
            (Sum::Number(sum), None) => Sum::Number(sum + f64::NAN),
            (Sum::Number(sum), Some(Json::Null)) => Sum::Number(sum),
            (Sum::Number(sum), Some(Json::Bool(amount))) => Sum::Number(sum + f64::from(u8::from(*amount))),
            (Sum::Number(sum), Some(Json::Number(amount))) => Sum::Number(sum + amount.as_f64().unwrap_or(f64::NAN)),
            (Sum::Number(sum), Some(amount)) => Sum::Text(number_to_string(sum) + &to_js_string(amount)),
            (Sum::Text(sum), None) => Sum::Text(sum + "undefined"),
            (Sum::Text(sum), Some(amount)) => Sum::Text(sum + &to_js_string(amount)),
        };
    }
    let sum = match sum {
        Sum::Number(sum) => sum,
        Sum::Text(sum) => to_number(&sum),
    };
    math_round(sum * 100.0) / 100.0
}

/// Split each of `transaction_ids` dated on or after `since` by a recurring's
/// default splits. A charge that already has splits keeps them, and one too
/// small to leave a remainder on the parent is left whole.
async fn apply_recurring_splits(
    executor: &dyn Executor,
    user_id: &str,
    splits: Option<&Json>,
    since: &Json,
    transaction_ids: &[Json],
) -> anyhow::Result<()> {
    let splits: &[Json] = match splits {
        None | Some(Json::Null) => &[],
        Some(Json::Array(splits)) => splits,
        Some(_) => anyhow::bail!("A recurring's splits are not an array"),
    };
    if splits.is_empty() || !truthy(since) || transaction_ids.is_empty() {
        return Ok(());
    }
    let total = splits_total(splits);
    let mut amounts = Vec::with_capacity(splits.len());
    let mut budget_ids = Vec::with_capacity(splits.len());
    let mut category_ids = Vec::with_capacity(splits.len());
    for split in splits {
        amounts.push(split.get("amount").cloned().unwrap_or(Json::Null));
        budget_ids.push(split_label_id(split, "budget_id")?.cloned().unwrap_or(Json::Null));
        category_ids.push(split_label_id(split, "category_id")?.cloned().unwrap_or(Json::Null));
    }
    executor
        .query(
            &format!(
                "INSERT INTO {SPLIT_TRANSACTIONS}
       ({USER_ID}, {TRANSACTION_ID}, account_id, amount, date,
        {LABEL_BUDGET_ID}, {LABEL_CATEGORY_ID}, {LABEL_CATEGORY_CONFIDENCE})
     SELECT t.{USER_ID}, t.{TRANSACTION_ID}, t.account_id, s.amount * SIGN(t.amount), t.date,
            s.budget_id, s.category_id,
            CASE WHEN s.category_id IS NOT NULL THEN 1 WHEN s.budget_id IS NOT NULL THEN 0 END
     FROM {TRANSACTIONS} t
     CROSS JOIN UNNEST($3::numeric[], $4::uuid[], $5::uuid[]) AS s(amount, budget_id, category_id)
     WHERE t.{USER_ID} = $1
       AND t.{TRANSACTION_ID} = ANY($2::text[])
       AND (t.{IS_DELETED} IS NULL OR t.{IS_DELETED} = FALSE)
       AND ABS(t.amount) > $6::numeric
       AND t.date >= $7::date
       AND NOT EXISTS (
         SELECT 1 FROM {SPLIT_TRANSACTIONS} x
         WHERE x.{USER_ID} = t.{USER_ID}
           AND x.{TRANSACTION_ID} = t.{TRANSACTION_ID}
           AND (x.{IS_DELETED} IS NULL OR x.{IS_DELETED} = FALSE)
       )"
            ),
            &[
                json!(user_id),
                Json::Array(transaction_ids.to_vec()),
                Json::Array(amounts),
                Json::Array(budget_ids),
                Json::Array(category_ids),
                num(total),
                since.clone(),
            ],
        )
        .await?;
    Ok(())
}

/// `row.transaction_ids` of a recurring read without its model.
fn member_ids(row: &Obj) -> anyhow::Result<&[Json]> {
    match row.get(TRANSACTION_IDS) {
        Some(Json::Array(ids)) => Ok(ids),
        _ => anyhow::bail!("A recurring's {TRANSACTION_IDS} are not an array"),
    }
}

/// Bring a confirmed recurring's transactions in line with its default
/// label. Without `transaction_ids` (confirming or creating it) every member
/// is labeled, and a recurring with no default starts one from its members.
/// With them (charges joining it) only those are labeled, and only if it has
/// a default: one the user cleared stays cleared. Joining charges are also
/// split by its default splits. Runs inside the caller's DB transaction,
/// under the recurrings advisory lock.
pub async fn label_confirmed_recurring(
    executor: &dyn Executor,
    user_id: &str,
    recurring_id: &str,
    transaction_ids: Option<&[String]>,
) -> anyhow::Result<()> {
    let found = executor
        .query(
            &format!(
                "SELECT {LABEL_BUDGET_ID}, {LABEL_CATEGORY_ID}, {TRANSACTION_IDS}, {SPLITS}, {SPLITS_SINCE}
     FROM {RECURRINGS}
     WHERE {USER_ID} = $1 AND {RECURRING_ID} = $2 AND {STATUS} = 'confirmed'"
            ),
            &[json!(user_id), json!(recurring_id)],
        )
        .await?;
    let Some(row) = found.rows.first() else { return Ok(()) };
    let transaction_ids: Option<Vec<Json>> = transaction_ids.map(|ids| ids.iter().map(|id| json!(id)).collect());
    if let Some(transaction_ids) = &transaction_ids {
        apply_recurring_splits(executor, user_id, row.get(SPLITS), &value_of(row, SPLITS_SINCE), transaction_ids).await?;
    }
    let mut label = Label::of(row, LABEL_BUDGET_ID, LABEL_CATEGORY_ID);
    if label.is_empty() {
        if transaction_ids.is_some() {
            return Ok(());
        }
        label = seed_recurring_label(executor, user_id, member_ids(row)?).await?;
        if label.is_empty() {
            return Ok(());
        }
        executor
            .query(
                &format!(
                    "UPDATE {RECURRINGS}
       SET {LABEL_BUDGET_ID} = $3::uuid, {LABEL_CATEGORY_ID} = $4::uuid, {UPDATED} = CURRENT_TIMESTAMP
       WHERE {USER_ID} = $1 AND {RECURRING_ID} = $2"
                ),
                &[json!(user_id), json!(recurring_id), label.budget_id.clone(), label.category_id.clone()],
            )
            .await?;
    }
    let transaction_ids: &[Json] = match &transaction_ids {
        Some(transaction_ids) => transaction_ids,
        None => member_ids(row)?,
    };
    apply_recurring_label(executor, user_id, &label, transaction_ids, &label).await
}

/// The `catch` every transaction here ends with: a failure rolls the
/// transaction back, whether or not the `ROLLBACK` itself succeeds, and is
/// passed on.
async fn or_rollback<T>(client: &Client, work: impl Future<Output = anyhow::Result<T>>) -> anyhow::Result<T> {
    match work.await {
        Ok(value) => Ok(value),
        Err(error) => {
            let _ = client.query("ROLLBACK", &[]).await;
            Err(error)
        }
    }
}

/// Confirm a suggested recurring: status flips to "confirmed" and its
/// transactions take its default label (seeded from them if it has none).
/// Confirmed recurrings auto-attach future matching charges on subsequent
/// detection runs.
pub async fn confirm_recurring(user: &MaskedUser, recurring_id: &str) -> anyhow::Result<RecurringConfirmResult> {
    let client = pool().connect().await?;
    or_rollback(&client, async {
        client.query("BEGIN", &[]).await?;
        lock_recurrings(&client, &user.user_id).await?;
        let updated = client
            .query(
                &format!(
                    "UPDATE {RECURRINGS}
       SET {STATUS} = 'confirmed', {UPDATED} = CURRENT_TIMESTAMP
       WHERE {USER_ID} = $1 AND {RECURRING_ID} = $2
         AND ({IS_DELETED} IS NULL OR {IS_DELETED} = FALSE)
       RETURNING {RECURRING_ID}"
                ),
                &[json!(user.user_id), json!(recurring_id)],
            )
            .await?;
        if updated.row_count.unwrap_or(0) == 0 {
            client.query("ROLLBACK", &[]).await?;
            return Ok(RecurringConfirmResult::not_found());
        }
        label_confirmed_recurring(&client, &user.user_id, recurring_id, None).await?;
        client.query("COMMIT", &[]).await?;
        Ok(RecurringConfirmResult::Ok)
    })
    .await
}

/// Set a recurring's default label, a `JSONRecurringLabel`. While it's
/// confirmed its transactions follow the change, except ones the user labeled
/// differently from the old default. A suggested recurring just keeps the
/// label for when it's confirmed. An empty label clears the default: nothing
/// is relabeled, and charges joining later keep their own labels.
pub async fn set_recurring_label(user: &MaskedUser, recurring_id: &str, label: &Obj) -> anyhow::Result<RecurringConfirmResult> {
    let client = pool().connect().await?;
    or_rollback(&client, async {
        client.query("BEGIN", &[]).await?;
        lock_recurrings(&client, &user.user_id).await?;
        let found = client
            .query(
                &format!(
                    "SELECT {LABEL_BUDGET_ID}, {LABEL_CATEGORY_ID}, {STATUS}, {TRANSACTION_IDS} FROM {RECURRINGS}
       WHERE {USER_ID} = $1 AND {RECURRING_ID} = $2
         AND ({IS_DELETED} IS NULL OR {IS_DELETED} = FALSE)"
                ),
                &[json!(user.user_id), json!(recurring_id)],
            )
            .await?;
        let Some(row) = found.rows.first() else {
            client.query("ROLLBACK", &[]).await?;
            return Ok(RecurringConfirmResult::not_found());
        };
        let label = Label::of(label, "budget_id", "category_id");
        client
            .query(
                &format!(
                    "UPDATE {RECURRINGS}
       SET {LABEL_BUDGET_ID} = $3::uuid, {LABEL_CATEGORY_ID} = $4::uuid, {UPDATED} = CURRENT_TIMESTAMP
       WHERE {USER_ID} = $1 AND {RECURRING_ID} = $2"
                ),
                &[json!(user.user_id), json!(recurring_id), label.budget_id.clone(), label.category_id.clone()],
            )
            .await?;
        if str_of(row, STATUS) == "confirmed" {
            // With no stored default (one confirmed before defaults existed,
            // or one the user cleared), its transactions follow the label
            // they're most often confirmed with, so that's what moves to the
            // new default.
            let stored = Label::of(row, LABEL_BUDGET_ID, LABEL_CATEGORY_ID);
            let previous =
                if stored.is_empty() { seed_recurring_label(&client, &user.user_id, member_ids(row)?).await? } else { stored };
            apply_recurring_label(&client, &user.user_id, &label, member_ids(row)?, &previous).await?;
        }
        client.query("COMMIT", &[]).await?;
        Ok(RecurringConfirmResult::Ok)
    })
    .await
}

/// The ids the labels of `splits` name under `key`: every one that is set.
fn split_label_ids<'a>(splits: &'a [Json], key: &str) -> anyhow::Result<Vec<&'a Json>> {
    let mut ids = Vec::new();
    for split in splits {
        if let Some(id) = split_label_id(split, key)?.filter(|id| truthy(id)) {
            ids.push(id);
        }
    }
    Ok(ids)
}

/// Set the splits a recurring's joining charges take, `JSONRecurringSplit`s,
/// from today on: charges dated earlier, including ones a revived recurring
/// takes back, are left as they are. An empty list stops splitting new ones.
/// Every label must be the user's own.
pub async fn set_recurring_splits(user: &MaskedUser, recurring_id: &str, splits: &[Json]) -> anyhow::Result<RecurringConfirmResult> {
    let budget_ids = split_label_ids(splits, "budget_id")?;
    let category_ids = split_label_ids(splits, "category_id")?;
    // An id is text. One that is not is looked up as the text the database
    // would be sent for it, and is never among the ids found.
    let as_sent = |ids: &[&Json]| ids.iter().map(|id| to_js_string(id)).collect();
    let owned =
        get_owned_label_ids(user, &LabelIds { budget_ids: as_sent(&budget_ids), category_ids: as_sent(&category_ids) }).await?;
    let all_owned = |ids: &[&Json], owned: &HashSet<String>| ids.iter().all(|id| id.as_str().is_some_and(|id| owned.contains(id)));
    if !all_owned(&budget_ids, &owned.budget_ids) || !all_owned(&category_ids, &owned.category_ids) {
        return Ok(RecurringConfirmResult::Failed { error: "A split's budget or category was not found.".to_string() });
    }
    // JSONB takes the array, not a string.
    let mut data = Obj::new();
    data.insert(SPLITS.into(), Json::Array(splits.to_vec()));
    data.insert(SPLITS_SINCE.into(), json!(get_date_string(JsDate::now())));
    let updated = recurring::TABLE
        .update(
            &json!(recurring_id),
            &data,
            UpdateArgs { user_id: Some(&user.user_id), exclude_deleted: Some(true), ..Default::default() },
        )
        .await?;
    if updated.is_none() {
        return Ok(RecurringConfirmResult::not_found());
    }
    Ok(RecurringConfirmResult::Ok)
}

/// Dismiss a suggested (or confirmed) recurring: flips to
/// `status='dismissed'` (not soft-delete). The row persists as the detection
/// engine's per-merchant denylist signal so the same merchant group isn't
/// re-suggested on future runs, as `reject_transfer_pair` does for pairs.
/// Re-adding goes through `create_recurring`, which un-dismisses.
pub async fn dismiss_recurring(user: &MaskedUser, recurring_id: &str) -> anyhow::Result<RecurringConfirmResult> {
    let mut data = Obj::new();
    data.insert(STATUS.into(), json!("dismissed"));
    let result = recurring::TABLE
        .update(&json!(recurring_id), &data, UpdateArgs { user_id: Some(&user.user_id), ..Default::default() })
        .await?;
    if result.is_none() {
        return Ok(RecurringConfirmResult::not_found());
    }
    Ok(RecurringConfirmResult::Ok)
}

/// Rename a recurring. The name is display-only (grouping runs on
/// `merchant_key`), and detection never rewrites an existing row's name, so
/// the user's choice sticks.
pub async fn rename_recurring(user: &MaskedUser, recurring_id: &str, merchant_name: &str) -> anyhow::Result<RecurringConfirmResult> {
    let mut data = Obj::new();
    data.insert(MERCHANT_NAME.into(), json!(merchant_name));
    let result = recurring::TABLE
        .update(&json!(recurring_id), &data, UpdateArgs { user_id: Some(&user.user_id), ..Default::default() })
        .await?;
    if result.is_none() {
        return Ok(RecurringConfirmResult::not_found());
    }
    Ok(RecurringConfirmResult::Ok)
}

/// `CreateRecurringInput`.
#[derive(Clone, Debug, Default)]
pub struct CreateRecurringInput {
    pub transaction_ids: Vec<String>,
    pub merchant_key: String,
    pub merchant_name: String,
    /// The caller named the recurring explicitly, so the name also replaces
    /// an existing row's when the create lands on one.
    pub name_is_custom: bool,
    /// A `RecurringCadence`.
    pub cadence: String,
    pub is_income: bool,
}

/// `[...new Set(ids)]`: the distinct ids, each where it first appears.
fn unique_ids(ids: &[String]) -> Vec<String> {
    ids.iter().collect::<IndexSet<_>>().into_iter().cloned().collect()
}

/// Manually create a recurring from explicit transaction ids (the "mark as
/// recurring" affordance), or un-dismiss a previously-dismissed merchant
/// group. A single transaction is allowed: the user is asserting the pattern,
/// and the detection job's auto-attach will pick up future matches. Wrapped
/// in a single DB transaction with a per-user advisory lock so concurrent
/// creates can't put one transaction in two active recurrings.
///
/// Invariants enforced:
///   - REJECT if any transaction is already in ANOTHER active recurring. A
///     transaction may appear in at most one active recurring.
///   - ALLOW re-creating a previously-dismissed merchant group: the ON
///     CONFLICT branch un-dismisses (as `pair_transactions` un-rejects).
///     Landing on a still-suggested row confirms it too: either way the user
///     has just said this merchant recurs.
pub async fn create_recurring(user: &MaskedUser, input: CreateRecurringInput) -> anyhow::Result<RecurringResult> {
    let unique_ids = unique_ids(&input.transaction_ids);
    if unique_ids.is_empty() {
        return Ok(RecurringResult::Failed { error: "A recurring needs at least one transaction.".to_string() });
    }

    let ids = json!(unique_ids);

    let recurring_id = uuid::Uuid::new_v4().to_string();
    let client = pool().connect().await?;
    or_rollback(&client, async {
        client.query("BEGIN", &[]).await?;
        client.query("SELECT pg_advisory_xact_lock(hashtext($1 || ':recurrings'))", &[json!(user.user_id)]).await?;

        // Existence pre-check: every transaction must exist, be alive, and
        // belong to this user. `FOR SHARE` serializes against a concurrent
        // delete (as in `pair_transactions`).
        let existence = client
            .query(
                &format!(
                    "SELECT {TRANSACTION_ID} FROM {TRANSACTIONS}
       WHERE {USER_ID} = $1
         AND {TRANSACTION_ID} = ANY($2::text[])
         AND ({IS_DELETED} IS NULL OR {IS_DELETED} = FALSE)
       FOR SHARE"
                ),
                &[json!(user.user_id), ids.clone()],
            )
            .await?;
        if existence.row_count.unwrap_or(0) != unique_ids.len() as u64 {
            client.query("ROLLBACK", &[]).await?;
            return Ok(RecurringResult::Failed {
                error: "One or more transactions no longer exist (deleted or never belonged to this user).".to_string(),
            });
        }

        // Collision pre-check: is ANY transaction already in another active
        // recurring? The transaction_ids array makes this a single overlap
        // probe with the && array operator. Rows for the same
        // (merchant_key, is_income) that are merely dismissed don't collide:
        // the upsert below un-dismisses them.
        let collision = client
            .query(
                &format!(
                    "SELECT {RECURRING_ID} FROM {RECURRINGS}
       WHERE {USER_ID} = $1
         AND ({IS_DELETED} IS NULL OR {IS_DELETED} = FALSE)
         AND {STATUS} <> 'dismissed'
         AND {TRANSACTION_IDS} && $2::text[]
       LIMIT 1"
                ),
                &[json!(user.user_id), ids.clone()],
            )
            .await?;
        if collision.row_count.unwrap_or(0) > 0 {
            client.query("ROLLBACK", &[]).await?;
            return Ok(RecurringResult::Failed {
                error: "One of these transactions is already in another recurring. Remove it from the existing recurring first."
                    .to_string(),
            });
        }

        let result = client
            .query(
                &format!(
                    "INSERT INTO {RECURRINGS}
         ({RECURRING_ID}, {USER_ID}, {MERCHANT_KEY}, {MERCHANT_NAME}, {CADENCE}, {IS_INCOME}, {STATUS}, {TRANSACTION_IDS})
       VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', $7)
       ON CONFLICT ({USER_ID}, {MERCHANT_KEY}, {IS_INCOME}) DO UPDATE SET
         {STATUS} = 'confirmed',
         {MERCHANT_NAME} = CASE
           WHEN $8::boolean THEN EXCLUDED.{MERCHANT_NAME}
           ELSE {RECURRINGS}.{MERCHANT_NAME}
         END,
         {TRANSACTION_IDS} = (
           SELECT ARRAY(SELECT DISTINCT UNNEST({RECURRINGS}.{TRANSACTION_IDS} || EXCLUDED.{TRANSACTION_IDS}))
         ),
         {IS_DELETED} = FALSE,
         {UPDATED} = CURRENT_TIMESTAMP
       RETURNING {RECURRING_ID}"
                ),
                &[
                    json!(recurring_id),
                    json!(user.user_id),
                    json!(input.merchant_key),
                    json!(input.merchant_name),
                    json!(input.cadence),
                    json!(input.is_income),
                    ids.clone(),
                    json!(input.name_is_custom),
                ],
            )
            .await?;
        let created_id = result
            .rows
            .first()
            .and_then(|row| row.get(RECURRING_ID))
            .and_then(|id| id.as_str())
            .ok_or_else(|| anyhow::anyhow!("The recurring upsert returned no {RECURRING_ID}"))?
            .to_string();
        label_confirmed_recurring(&client, &user.user_id, &created_id, None).await?;

        client.query("COMMIT", &[]).await?;
        Ok(RecurringResult::Ok { recurring_id: created_id })
    })
    .await
}

/// Whether any of `transactions` runs against a recurring's direction: an
/// income recurring can't hold a charge, nor an expense one a deposit. A
/// negative amount is income.
fn wrong_direction(transactions: &[Obj], is_income: bool) -> bool {
    transactions.iter().any(|transaction| {
        let amount = transaction.get("amount").and_then(|amount| amount.as_f64()).unwrap_or(0.0);
        (amount < 0.0) != is_income
    })
}

/// Add transactions to an existing recurring (the "add to recurring"
/// affordance on the transaction detail page). The recurring keeps its
/// merchant_key/cadence/is_income; the added transactions just join its
/// member set.
///
/// Invariants enforced (same guards as `create_recurring`):
///   - The recurring must exist, belong to this user, be alive, and not be
///     dismissed (adding to a dismissed group would fight the denylist).
///   - Every transaction must exist, be alive, and belong to this user.
///   - REJECT if any transaction is already in ANOTHER active recurring.
///     Transactions already in THIS recurring are silently deduped.
///   - REJECT if a transaction's direction doesn't match the recurring's
///     is_income: an income recurring can't hold a charge.
pub async fn add_to_recurring(user: &MaskedUser, recurring_id: &str, transaction_ids: &[String]) -> anyhow::Result<RecurringResult> {
    let unique_ids = unique_ids(transaction_ids);
    if unique_ids.is_empty() {
        return Ok(RecurringResult::Failed { error: "No transactions to add.".to_string() });
    }
    let ids = json!(unique_ids);

    let client = pool().connect().await?;
    or_rollback(&client, async {
        client.query("BEGIN", &[]).await?;
        client.query("SELECT pg_advisory_xact_lock(hashtext($1 || ':recurrings'))", &[json!(user.user_id)]).await?;

        let rec = client
            .query(
                &format!(
                    "SELECT {RECURRING_ID}, {IS_INCOME}, {STATUS} FROM {RECURRINGS}
       WHERE {USER_ID} = $1 AND {RECURRING_ID} = $2
         AND ({IS_DELETED} IS NULL OR {IS_DELETED} = FALSE)"
                ),
                &[json!(user.user_id), json!(recurring_id)],
            )
            .await?;
        let row = if rec.row_count.unwrap_or(0) == 0 { None } else { rec.rows.first() };
        let Some(row) = row else {
            client.query("ROLLBACK", &[]).await?;
            return Ok(RecurringResult::Failed { error: "That recurring no longer exists.".to_string() });
        };
        if str_of(row, STATUS) == "dismissed" {
            client.query("ROLLBACK", &[]).await?;
            return Ok(RecurringResult::Failed {
                error: "That recurring was dismissed. Confirm it again before adding transactions.".to_string(),
            });
        }
        let is_income = truthy_opt(row.get(IS_INCOME));

        let txns = client
            .query(
                &format!(
                    "SELECT {TRANSACTION_ID}, amount FROM {TRANSACTIONS}
       WHERE {USER_ID} = $1
         AND {TRANSACTION_ID} = ANY($2::text[])
         AND ({IS_DELETED} IS NULL OR {IS_DELETED} = FALSE)
         AND pending = FALSE
       FOR SHARE"
                ),
                &[json!(user.user_id), ids.clone()],
            )
            .await?;
        if txns.row_count.unwrap_or(0) != unique_ids.len() as u64 {
            client.query("ROLLBACK", &[]).await?;
            return Ok(RecurringResult::Failed {
                error: "One or more transactions no longer exist (deleted or never belonged to this user).".to_string(),
            });
        }
        if wrong_direction(&txns.rows, is_income) {
            client.query("ROLLBACK", &[]).await?;
            return Ok(RecurringResult::Failed {
                error: if is_income {
                    "That recurring holds income — only deposits can join it.".to_string()
                } else {
                    "That recurring holds charges — only expenses can join it.".to_string()
                },
            });
        }

        let collision = client
            .query(
                &format!(
                    "SELECT {RECURRING_ID} FROM {RECURRINGS}
       WHERE {USER_ID} = $1
         AND ({IS_DELETED} IS NULL OR {IS_DELETED} = FALSE)
         AND {STATUS} <> 'dismissed'
         AND {RECURRING_ID} <> $2
         AND {TRANSACTION_IDS} && $3::text[]
       LIMIT 1"
                ),
                &[json!(user.user_id), json!(recurring_id), ids.clone()],
            )
            .await?;
        if collision.row_count.unwrap_or(0) > 0 {
            client.query("ROLLBACK", &[]).await?;
            return Ok(RecurringResult::Failed {
                error: "One of these transactions is already in another recurring. Remove it from the existing recurring first."
                    .to_string(),
            });
        }

        client
            .query(
                &format!(
                    "UPDATE {RECURRINGS}
       SET {TRANSACTION_IDS} = (
         SELECT ARRAY(SELECT DISTINCT UNNEST({TRANSACTION_IDS} || $2::text[]))
       ),
       {UPDATED} = CURRENT_TIMESTAMP
       WHERE {RECURRING_ID} = $1 AND {USER_ID} = $3"
                ),
                &[json!(recurring_id), ids.clone(), json!(user.user_id)],
            )
            .await?;
        label_confirmed_recurring(&client, &user.user_id, recurring_id, Some(&unique_ids)).await?;

        client.query("COMMIT", &[]).await?;
        Ok(RecurringResult::Ok { recurring_id: recurring_id.to_string() })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::json_stringify;

    fn obj(value: Json) -> Obj {
        match value {
            Json::Object(map) => map,
            other => panic!("not an object: {other}"),
        }
    }

    fn recurring_row(overrides: Json) -> Row {
        let mut row = obj(json!({
            "recurring_id": "rec-1",
            "user_id": "usr-1",
            "merchant_key": "netflix",
            "merchant_name": "Netflix",
            "cadence": "monthly",
            "is_income": false,
            "status": "confirmed",
            "transaction_ids": ["tx-1", "tx-2"],
            "label_budget_id": "b-1",
            "label_category_id": null,
            "splits": [{ "amount": 5, "label": { "budget_id": null, "category_id": "c-1" } }],
            "splits_since": "2026-03-01",
            "created_at": "2026-01-01T00:00:00.000Z",
            "updated": "2026-06-01T00:00:00.000Z",
            "is_deleted": false,
        }));
        row.extend(obj(overrides));
        recurring::TABLE.validate(row).unwrap()
    }

    fn transactions(ids: &[&str]) -> HashMap<String, Json> {
        ids.iter().map(|id| (id.to_string(), json!({ "transaction_id": id }))).collect()
    }

    /// What `get_recurrings` makes of the rows its two queries returned.
    fn assemble(all: &[Row], txn_by_id: &HashMap<String, Json>, include_deleted: bool) -> Vec<Recurring> {
        let visible: Vec<&Row> = all.iter().filter(|recurring| is_visible(recurring)).collect();
        let evictions = if include_deleted {
            all.iter().filter(|recurring| !is_visible(recurring)).map(to_eviction).collect()
        } else {
            Vec::new()
        };
        resolve_recurrings(&visible, txn_by_id, include_deleted, evictions)
    }

    fn ids(recurrings: &[Recurring]) -> Vec<&str> {
        recurrings.iter().map(|recurring| recurring["recurring_id"].as_str().unwrap()).collect()
    }

    #[test]
    fn a_recurring_carries_its_live_members_label_and_splits() {
        let rows = [recurring_row(json!({ "transaction_ids": ["tx-2", "tx-gone", "tx-1"] }))];
        let result = assemble(&rows, &transactions(&["tx-1", "tx-2"]), false);
        assert_eq!(
            json_stringify(&Json::Array(result)),
            json_stringify(&json!([{
                "recurring_id": "rec-1",
                "merchant_key": "netflix",
                "merchant_name": "Netflix",
                "cadence": "monthly",
                "is_income": false,
                "status": "confirmed",
                "transactions": [{ "transaction_id": "tx-2" }, { "transaction_id": "tx-1" }],
                "label": { "budget_id": "b-1", "category_id": null },
                "splits": [{ "amount": 5, "label": { "budget_id": null, "category_id": "c-1" } }],
                "updated": "2026-06-01T00:00:00.000Z",
            }]))
        );
    }

    #[test]
    fn dismissed_and_deleted_recurrings_are_hidden() {
        assert!(is_visible(&recurring_row(json!({}))));
        assert!(is_visible(&recurring_row(json!({ "status": "suggested", "is_deleted": null }))));
        assert!(!is_visible(&recurring_row(json!({ "status": "dismissed" }))));
        assert!(!is_visible(&recurring_row(json!({ "is_deleted": true }))));
    }

    #[test]
    fn active_recurrings_come_first_then_hidden_ones_then_memberless_ones() {
        let rows = [
            recurring_row(json!({ "recurring_id": "r1", "status": "dismissed" })),
            recurring_row(json!({ "recurring_id": "r2", "transaction_ids": ["tx-gone"] })),
            recurring_row(json!({ "recurring_id": "r3", "status": "suggested" })),
            recurring_row(json!({ "recurring_id": "r4", "is_deleted": true, "updated": null })),
            recurring_row(json!({ "recurring_id": "r5", "transaction_ids": [] })),
        ];
        let txns = transactions(&["tx-1", "tx-2"]);

        let delta = assemble(&rows, &txns, true);
        assert_eq!(ids(&delta), ["r3", "r1", "r4", "r2", "r5"]);
        assert_eq!(delta[0]["transactions"].as_array().unwrap().len(), 2);
        for eviction in &delta[1..] {
            assert_eq!(eviction["transactions"], json!([]));
            assert_eq!(eviction["label"], json!({ "budget_id": "b-1", "category_id": null }));
            assert_eq!(eviction["splits"].as_array().unwrap().len(), 1);
        }
        assert_eq!(delta[2]["updated"], Json::Null);

        // Without eviction signals the hidden and memberless recurrings are simply left out.
        assert_eq!(ids(&assemble(&rows, &txns, false)), ["r3"]);
    }

    #[test]
    fn a_label_is_empty_when_it_names_neither_a_budget_nor_a_category() {
        let label = |value: Json| Label::of(&obj(value), "budget_id", "category_id");
        assert!(label(json!({ "budget_id": null, "category_id": null })).is_empty());
        assert!(label(json!({})).is_empty());
        assert!(label(json!({ "budget_id": "", "category_id": "" })).is_empty());
        assert!(!label(json!({ "budget_id": "b-1", "category_id": null })).is_empty());
        assert!(!label(json!({ "budget_id": null, "category_id": "c-1" })).is_empty());
        assert!(Label::EMPTY.is_empty());
        assert_eq!(label(json!({ "category_id": "c-1" })), Label { budget_id: Json::Null, category_id: json!("c-1") });
    }

    // `post-recurring.test.ts`, "a budget-only default marks the category empty on purpose, not unlabeled".
    #[test]
    fn a_budget_only_default_marks_the_category_empty_on_purpose() {
        let label = |value: Json| Label::of(&obj(value), "budget_id", "category_id");
        assert_eq!(label(json!({ "budget_id": "b-1", "category_id": null })).confidence(), 0);
        assert_eq!(label(json!({ "budget_id": "b-1", "category_id": "c-1" })).confidence(), 1);
        assert_eq!(label(json!({ "budget_id": null, "category_id": "c-1" })).confidence(), 1);
    }

    #[test]
    fn splits_total_is_rounded_to_cents() {
        let split = |amount: f64| json!({ "amount": amount, "label": { "budget_id": null, "category_id": null } });
        assert_eq!(splits_total(&[split(0.1), split(0.2)]), 0.3);
        assert_eq!(splits_total(&[split(12.34), split(5.0), split(0.01)]), 17.35);
        assert_eq!(splits_total(&[split(1.005)]), 1.0);
        assert_eq!(splits_total(&[]), 0.0);
    }

    // What `splits.reduce((sum, s) => sum + s.amount, 0)` gives in JavaScript, then rounded.
    #[test]
    fn splits_total_adds_what_is_not_a_number_as_javascript_does() {
        let total = |amounts: Json| -> f64 {
            let splits: Vec<Json> = amounts.as_array().unwrap().iter().map(|amount| json!({ "amount": amount })).collect();
            splits_total(&splits)
        };
        assert_eq!(total(json!([2.5, null, true, false])), 3.5);
        // 0 + "5" is "05", and "05" + 2.5 is "052.5".
        assert_eq!(total(json!(["5"])), 5.0);
        assert_eq!(total(json!(["5", 2.5])), 52.5);
        // "1.52null" is not a number.
        assert!(total(json!([1.5, "2", null])).is_nan());
        assert!(total(json!([1, {}])).is_nan());
        assert_eq!(total(json!([1, [2]])), 12.0);
        assert!(splits_total(&[json!({ "label": {} })]).is_nan());
        assert!(splits_total(&[json!({ "amount": "1" }), json!({})]).is_nan());
        assert!(splits_total(&[json!(5)]).is_nan());
    }

    #[test]
    fn split_label_ids_are_the_ones_the_splits_name() {
        let splits = [
            json!({ "amount": 1, "label": { "budget_id": "b-1", "category_id": null } }),
            json!({ "amount": 2, "label": { "budget_id": null, "category_id": "c-1" } }),
            json!({ "amount": 3, "label": { "budget_id": "b-1", "category_id": "c-2" } }),
            json!({ "amount": 4, "label": {} }),
            json!({ "amount": 5, "label": { "budget_id": "", "category_id": 0 } }),
        ];
        assert_eq!(split_label_ids(&splits, "budget_id").unwrap(), [&json!("b-1"), &json!("b-1")]);
        assert_eq!(split_label_ids(&splits, "category_id").unwrap(), [&json!("c-1"), &json!("c-2")]);

        // A split with no label is an error, as reading through `undefined` is.
        assert!(split_label_ids(&[json!({ "amount": 1 })], "budget_id").is_err());
        assert!(split_label_ids(&[json!({ "amount": 1, "label": null })], "category_id").is_err());
        assert!(split_label_ids(&[Json::Null], "budget_id").is_err());
    }

    #[test]
    fn unique_ids_keep_the_first_appearance_of_each() {
        let ids: Vec<String> = ["tx-2", "tx-1", "tx-2", "tx-3", "tx-1"].iter().map(|id| id.to_string()).collect();
        assert_eq!(unique_ids(&ids), ["tx-2", "tx-1", "tx-3"]);
        assert!(unique_ids(&[]).is_empty());
    }

    #[test]
    fn a_transaction_joins_only_a_recurring_of_its_direction() {
        let rows = |amounts: &[Json]| -> Vec<Obj> {
            amounts.iter().map(|amount| obj(json!({ "transaction_id": "tx", "amount": amount }))).collect()
        };
        // A negative amount is a deposit.
        assert!(!wrong_direction(&rows(&[json!(-1200), json!(-0.01)]), true));
        assert!(wrong_direction(&rows(&[json!(-1200), json!(15.99)]), true));
        assert!(!wrong_direction(&rows(&[json!(15.99), json!(9)]), false));
        assert!(wrong_direction(&rows(&[json!(15.99), json!(-9)]), false));
        // Zero and a missing amount count as charges.
        assert!(wrong_direction(&rows(&[json!(0)]), true));
        assert!(!wrong_direction(&rows(&[Json::Null]), false));
        assert!(!wrong_direction(&[], true));
    }

    // A route handler and the detection job are boxed `Send` futures, so what they await has to be `Send` too.
    #[test]
    fn the_futures_can_be_awaited_from_a_route() {
        fn assert_send<T: Send>(_future: T) {}
        let user = MaskedUser { user_id: "usr-1".into(), username: "tester".into() };
        let ids = ["tx-1".to_string()];
        assert_send(get_recurrings(&user, GetRecurringsOptions::default()));
        assert_send(label_confirmed_recurring(pool(), "usr-1", "rec-1", Some(&ids)));
        assert_send(confirm_recurring(&user, "rec-1"));
        assert_send(set_recurring_label(&user, "rec-1", &Obj::new()));
        assert_send(set_recurring_splits(&user, "rec-1", &[]));
        assert_send(dismiss_recurring(&user, "rec-1"));
        assert_send(rename_recurring(&user, "rec-1", "Netflix"));
        assert_send(create_recurring(&user, CreateRecurringInput::default()));
        assert_send(add_to_recurring(&user, "rec-1", &ids));
    }

    #[test]
    fn results_are_the_objects_the_typescript_returns() {
        assert_eq!(
            json_stringify(&RecurringResult::Ok { recurring_id: "r".into() }.to_json()),
            r#"{"ok":true,"recurring_id":"r"}"#
        );
        assert_eq!(json_stringify(&RecurringResult::Failed { error: "no".into() }.to_json()), r#"{"ok":false,"error":"no"}"#);
        assert_eq!(json_stringify(&RecurringConfirmResult::Ok.to_json()), r#"{"ok":true}"#);
        assert_eq!(
            json_stringify(&RecurringConfirmResult::not_found().to_json()),
            r#"{"ok":false,"error":"Recurring not found."}"#
        );
    }
}
