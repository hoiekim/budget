//! `src/server/lib/postgres/repositories/transfers.ts`.
//!
//! The result unions become enums carrying the same information:
//! `PairResult` `{ ok: true, pair_id }` is [`PairResult::Ok`] and
//! `{ ok: false, error }` is [`PairResult::Failed`]; `ConfirmResult`
//! `{ ok: true }` is [`ConfirmResult::Ok`] and `{ ok: false, error }` is
//! [`ConfirmResult::Failed`]. `to_json` gives the object the TypeScript
//! returns.

use std::collections::HashMap;
use std::future::Future;

use serde_json::json;

use crate::common::constants::{TRANSACTIONS, TRANSACTION_PAIRS};
use crate::filters;
use crate::js::{truthy, truthy_opt, Json, Obj};
use crate::server::postgres::client::{pool, Executor};
use crate::server::postgres::database::{
    shared_with, shared_with_sql, sharing_lock_key_sql, DateRange, SearchFilters, SHARING_MEMBERSHIP_LOCK_KEY,
};
use crate::server::postgres::models::base::{str_of, value_of};
use crate::server::postgres::models::common::{
    IS_DELETED, PAIR_ID, STATUS, TRANSACTION_ID, TRANSACTION_ID_A, TRANSACTION_ID_B, UPDATED, USER_ID,
};
use crate::server::postgres::models::transaction_pair::canonicalize_pair_ids;
use crate::server::postgres::models::{transaction, transaction_pair, MaskedUser, Row};

/// Serializes every transfer-pair write in `user_id`'s sharing group: manual
/// pairing, confirming, and the detection job. Without it, two concurrent
/// writers (double-click, two tabs, two people sharing data, the hourly job)
/// can each pass a collision check before either commits (READ COMMITTED
/// hides the in-flight write) and leave one transaction in two active pairs.
/// The group cannot change until the caller's transaction ends, so a pair is
/// never written across people who have just stopped sharing.
pub async fn lock_transfer_pairs(client: &dyn Executor, user_id: &str) -> anyhow::Result<()> {
    client.query(&format!("SELECT pg_advisory_xact_lock_shared({SHARING_MEMBERSHIP_LOCK_KEY})"), &[]).await?;
    client
        .query(
            &format!("SELECT pg_advisory_xact_lock(hashtext({} || ':transfers'))", sharing_lock_key_sql("$1")),
            &[json!(user_id)],
        )
        .await?;
    Ok(())
}

/// A transfer pair as the API delivers it, the TypeScript `TransferPair`:
/// `{ pair_id, status, transactions, updated }`, where `transactions` holds
/// the two paired transactions as `JSONTransaction`s, or nothing on an
/// eviction signal. `updated` is bumped on every mutation
/// (confirm/reject/cascade-delete), which lets the client reduce over a delta
/// by `updated` instead of replacing its cache wholesale: the role `updated`
/// plays on transactions and snapshots.
pub type TransferPair = Json;

/// `GetTransferPairsOptions`.
#[derive(Clone, Debug, Default)]
pub struct GetTransferPairsOptions {
    /// When true, non-renderable pairs are included as eviction signals.
    /// Defaults to false: a caller that just wants the current pair list gets
    /// active-non-rejected rows only.
    pub include_deleted: bool,
    /// Delta cursor. When set (and not empty), only pairs whose
    /// `updated >= start_date` are returned, so a warm sync costs
    /// O(pairs-changed) instead of O(pairs). Backed by the
    /// `(user_id, updated)` composite index on the table.
    pub start_date: Option<String>,
}

/// Result of a pair mutation, the TypeScript `PairResult`:
/// `{ ok: true, pair_id }` is `Ok { pair_id }` and `{ ok: false, error }` is
/// `Failed { error }`. The route turns a `Failed` into a
/// `{ status: "failed", message }` response so the client can surface the
/// conflict.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PairResult {
    Ok { pair_id: String },
    Failed { error: String },
}

impl PairResult {
    /// The object the TypeScript returns.
    pub fn to_json(&self) -> Json {
        match self {
            PairResult::Ok { pair_id } => json!({ "ok": true, "pair_id": pair_id }),
            PairResult::Failed { error } => json!({ "ok": false, "error": error }),
        }
    }
}

/// Result of a confirm, the TypeScript `ConfirmResult`: `{ ok: true }` is
/// `Ok` and `{ ok: false, error }` is `Failed { error }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConfirmResult {
    Ok,
    Failed { error: String },
}

impl ConfirmResult {
    /// The object the TypeScript returns.
    pub fn to_json(&self) -> Json {
        match self {
            ConfirmResult::Ok => json!({ "ok": true }),
            ConfirmResult::Failed { error } => json!({ "ok": false, "error": error }),
        }
    }
}

const ALREADY_PAIRED: &str =
    "One of these transactions is already in another confirmed transfer pair. Reject or unpair the existing pair first.";

/// A pair is visible to the client only when it's active AND not
/// user-rejected. Both `is_deleted` (soft-delete / cascade) and
/// `status='rejected'` (user marked "no, these don't pair") hide a pair from
/// the Transfers view: rejected is transfers' second hidden axis
/// (transactions and snapshots have only `is_deleted`). Re-confirming a
/// rejected pair goes through `pair_transactions` (Mark as Transfer), which
/// un-rejects via ON CONFLICT. Rejection is checked here because
/// `Table::query` has no `<>` inequality.
fn is_visible(pair: &Row) -> bool {
    !truthy_opt(pair.get(IS_DELETED)) && str_of(pair, STATUS) != "rejected"
}

fn to_transfer_pair(pair: &Row, transactions: Vec<Json>) -> TransferPair {
    let mut out = Obj::new();
    out.insert("pair_id".into(), value_of(pair, PAIR_ID));
    out.insert("status".into(), value_of(pair, STATUS));
    out.insert("transactions".into(), Json::Array(transactions));
    out.insert("updated".into(), value_of(pair, UPDATED));
    Json::Object(out)
}

/// A pair the client must drop from its cache. Eviction signals need no
/// transaction resolution: a cascade soft-delete may have soft-deleted the
/// referenced transactions too, and the active-only transaction query
/// wouldn't find them.
fn to_eviction(pair: &Row) -> TransferPair {
    to_transfer_pair(pair, Vec::new())
}

/// The visible pairs with their two transactions inline, followed by
/// `evictions`. An active pair one of whose halves no longer resolves is
/// left out, and under `include_deleted` joins the evictions: omitting it was
/// enough while the client replaced its cache wholesale, but a delta reducer
/// never revisits an id it is not sent. This only reaches a cursor-filtered
/// caller when something bumped the pair's own `updated` after the cursor;
/// orphaning a half does not, so it is not on its own a stale-half fix.
fn resolve_pairs(
    visible_pairs: &[&Row],
    txn_by_id: &HashMap<String, Json>,
    include_deleted: bool,
    mut evictions: Vec<TransferPair>,
) -> Vec<TransferPair> {
    let mut active: Vec<TransferPair> = Vec::new();
    for pair in visible_pairs {
        let a = txn_by_id.get(str_of(pair, TRANSACTION_ID_A));
        let b = txn_by_id.get(str_of(pair, TRANSACTION_ID_B));
        match (a, b) {
            (Some(a), Some(b)) => active.push(to_transfer_pair(pair, vec![a.clone(), b.clone()])),
            _ => {
                if include_deleted {
                    evictions.push(to_eviction(pair));
                }
            }
        }
    }
    active.extend(evictions);
    active
}

/// Get all transfer pairs for a user, theirs and those of everyone sharing
/// data with them. Resolves the two transactions each pair references so the
/// response keeps one entry per pair, with the two paired transactions inline.
pub async fn get_transfer_pairs(user: &MaskedUser, options: GetTransferPairsOptions) -> anyhow::Result<Vec<TransferPair>> {
    get_transfer_pairs_on(pool(), user, options).await
}

async fn get_transfer_pairs_on(
    executor: &dyn Executor,
    user: &MaskedUser,
    options: GetTransferPairsOptions,
) -> anyhow::Result<Vec<TransferPair>> {
    // `Table::query` excludes soft-deleted rows by default. When the caller
    // opts into tombstone delivery, keep them by unsetting the exclusion,
    // matching the transactions/snapshots delta-delivery contract.
    // `start_date` narrows the SQL scan to rows whose `updated >= $cursor`, so
    // a warm sync fetches only the delta instead of the full pair set.
    let all_pairs = transaction_pair::TABLE
        .query(
            filters! { USER_ID => shared_with(user) },
            SearchFilters {
                order_by: Some(PAIR_ID.to_string()),
                exclude_deleted: Some(!options.include_deleted),
                date_range: options
                    .start_date
                    .filter(|start| !start.is_empty())
                    .map(|start| DateRange { column: UPDATED.to_string(), start: Some(start), end: None }),
                ..Default::default()
            },
            Some(executor),
        )
        .await?;

    if all_pairs.is_empty() {
        return Ok(Vec::new());
    }

    let visible_pairs: Vec<&Row> = all_pairs.iter().filter(|pair| is_visible(pair)).collect();

    // Under `include_deleted`, every non-visible pair (soft-deleted OR
    // rejected) is delivered as an eviction signal so the delta-reducing
    // client removes it from its local cache. On the default path `all_pairs`
    // already excludes soft-deleted rows at the SQL layer and rejected pairs
    // are simply omitted, so there are no eviction signals.
    let evictions: Vec<TransferPair> = if options.include_deleted {
        all_pairs.iter().filter(|pair| !is_visible(pair)).map(to_eviction).collect()
    } else {
        Vec::new()
    };

    if visible_pairs.is_empty() {
        return Ok(evictions);
    }

    let txn_ids: Vec<Json> =
        visible_pairs.iter().flat_map(|pair| [value_of(pair, TRANSACTION_ID_A), value_of(pair, TRANSACTION_ID_B)]).collect();

    let txn_models = transaction::TABLE
        .query(
            filters! { USER_ID => shared_with(user) },
            SearchFilters { in_filters: vec![(TRANSACTION_ID.to_string(), txn_ids)], ..Default::default() },
            Some(executor),
        )
        .await?;

    let mut txn_by_id: HashMap<String, Json> = HashMap::new();
    for model in &txn_models {
        txn_by_id.insert(str_of(model, TRANSACTION_ID).to_string(), transaction::to_json(model));
    }

    Ok(resolve_pairs(&visible_pairs, &txn_by_id, options.include_deleted, evictions))
}

/// The `catch` both transactions here end with: a failure rolls the
/// transaction back and is passed on. When the `ROLLBACK` fails too, its
/// failure is the one passed on.
async fn or_rollback<T>(client: &dyn Executor, work: impl Future<Output = anyhow::Result<T>>) -> anyhow::Result<T> {
    match work.await {
        Ok(value) => Ok(value),
        Err(error) => {
            client.query("ROLLBACK", &[]).await?;
            Err(error)
        }
    }
}

/// Of the rows the existence pre-check found, the owner of each transaction
/// by id. A repeated id keeps its last row, as a JavaScript `Map` does.
fn owners_by_transaction(rows: &[Obj]) -> HashMap<String, Json> {
    rows.iter().map(|row| (str_of(row, TRANSACTION_ID).to_string(), value_of(row, USER_ID))).collect()
}

/// Pair two transactions as a transfer. Wrapped in a single DB transaction so
/// the collision pre-check, upsert, and cleanup of other suggestions are
/// atomic. `status` is "suggested" when `None`.
///
/// Invariants enforced:
///   - REJECT if either transaction is already in ANOTHER active confirmed
///     pair (i.e. not the same `(a, b)` we're re-pairing). A transaction may
///     appear in at most one active confirmed pair.
///   - ALLOW re-pairing a previously-rejected `(a, b)`: the ON CONFLICT
///     branch un-rejects.
///   - On successful upsert, REJECT (status='rejected') any OTHER active
///     SUGGESTED pair that involves either `a` or `b`. The user's explicit
///     pairing is an implicit "the other engine guesses for these
///     transactions are wrong"; flipping them to 'rejected' persists that
///     intent through the engine's per-pair denylist on future runs.
///     Consistent with transaction labeling: confirming one category
///     implicitly rejects the engine's other category guesses, and the engine
///     remembers.
pub async fn pair_transactions(
    user: &MaskedUser,
    transaction_id_a: &str,
    transaction_id_b: &str,
    status: Option<&str>,
) -> anyhow::Result<PairResult> {
    let status = status.unwrap_or("suggested");
    let pair_id = uuid::Uuid::new_v4().to_string();
    let client = pool().connect().await?;
    pair_transactions_on(&client, user, &pair_id, transaction_id_a, transaction_id_b, status).await
}

async fn pair_transactions_on(
    client: &dyn Executor,
    user: &MaskedUser,
    pair_id: &str,
    transaction_id_a: &str,
    transaction_id_b: &str,
    status: &str,
) -> anyhow::Result<PairResult> {
    let canonical = canonicalize_pair_ids(transaction_id_a, transaction_id_b);
    or_rollback(client, async {
        client.query("BEGIN", &[]).await?;

        lock_transfer_pairs(client, &user.user_id).await?;

        // Existence pre-check: BOTH transactions must exist, be alive, and
        // belong to this user or to someone sharing data with them.
        // `FOR SHARE` takes a row-level share lock that conflicts with the
        // EXCLUSIVE lock a delete of the transaction takes, serializing the
        // existence check against any concurrent delete: without it, a delete
        // could commit between our SELECT and INSERT, leaving a confirmed
        // pair referencing a soft-deleted transaction. Returns 0/1/2 rows; we
        // expect 2.
        let existence = client
            .query(
                &format!(
                    "SELECT {TRANSACTION_ID}, {USER_ID} FROM {TRANSACTIONS}
       WHERE {}
         AND {TRANSACTION_ID} = ANY($2::text[])
         AND ({IS_DELETED} IS NULL OR {IS_DELETED} = FALSE)
       FOR SHARE",
                    shared_with_sql(USER_ID, "$1")
                ),
                &[json!(user.user_id), json!([canonical.transaction_id_a, canonical.transaction_id_b])],
            )
            .await?;
        let owner_of = owners_by_transaction(&existence.rows);
        // A pair belongs to an owner of its transactions, never to a third
        // member of their sharing group: once sharing ends, whoever still
        // holds both transactions still holds the pair.
        let pair_owner_id = owner_of.get(canonical.transaction_id_a).filter(|owner| truthy(owner));
        let Some(pair_owner_id) = pair_owner_id.filter(|_| owner_of.contains_key(canonical.transaction_id_b)) else {
            client.query("ROLLBACK", &[]).await?;
            return Ok(PairResult::Failed {
                error: "One or both transactions no longer exist (deleted or never belonged to this user).".to_string(),
            });
        };

        // Collision pre-check: is EITHER transaction in another active
        // confirmed pair with a different counterparty? If so, refuse:
        // confirming would put the transaction in two simultaneous confirmed
        // pairs.
        let collision = client
            .query(
                &format!(
                    "SELECT {PAIR_ID} FROM {TRANSACTION_PAIRS}
       WHERE {}
         AND ({IS_DELETED} IS NULL OR {IS_DELETED} = FALSE)
         AND {STATUS} = 'confirmed'
         AND ({TRANSACTION_ID_A} = $2 OR {TRANSACTION_ID_B} = $2
              OR {TRANSACTION_ID_A} = $3 OR {TRANSACTION_ID_B} = $3)
         AND NOT ({TRANSACTION_ID_A} = $4 AND {TRANSACTION_ID_B} = $5)
       LIMIT 1",
                    shared_with_sql(USER_ID, "$1")
                ),
                &[
                    json!(user.user_id),
                    json!(canonical.transaction_id_a),
                    json!(canonical.transaction_id_b),
                    json!(canonical.transaction_id_a),
                    json!(canonical.transaction_id_b),
                ],
            )
            .await?;
        if collision.row_count.unwrap_or(0) > 0 {
            client.query("ROLLBACK", &[]).await?;
            return Ok(PairResult::Failed { error: ALREADY_PAIRED.to_string() });
        }

        let result = client
            .query(
                &format!(
                    "INSERT INTO {TRANSACTION_PAIRS}
         ({PAIR_ID}, {USER_ID}, {TRANSACTION_ID_A}, {TRANSACTION_ID_B}, {STATUS})
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT ({TRANSACTION_ID_A}, {TRANSACTION_ID_B}) DO UPDATE SET
         {STATUS} = CASE
           WHEN {TRANSACTION_PAIRS}.{IS_DELETED} = TRUE THEN EXCLUDED.{STATUS}
           WHEN {TRANSACTION_PAIRS}.{STATUS} = 'rejected' THEN EXCLUDED.{STATUS}
           ELSE {TRANSACTION_PAIRS}.{STATUS}
         END,
         {IS_DELETED} = FALSE,
         updated = CASE
           WHEN {TRANSACTION_PAIRS}.{IS_DELETED} = TRUE
             OR {TRANSACTION_PAIRS}.{STATUS} = 'rejected'
             THEN CURRENT_TIMESTAMP
           ELSE {TRANSACTION_PAIRS}.updated
         END
       RETURNING {PAIR_ID}"
                ),
                &[
                    json!(pair_id),
                    pair_owner_id.clone(),
                    json!(canonical.transaction_id_a),
                    json!(canonical.transaction_id_b),
                    json!(status),
                ],
            )
            .await?;

        let effective_pair_id = result
            .rows
            .first()
            .and_then(|row| row.get(PAIR_ID))
            .and_then(|id| id.as_str())
            .ok_or_else(|| anyhow::anyhow!("The transfer pair upsert returned no {PAIR_ID}"))?
            .to_string();

        // Cleanup: REJECT any OTHER active SUGGESTED pair involving either
        // transaction. The user's manual pair is an explicit "this is the
        // right pairing", so any other engine suggestion for the same
        // transactions is implicitly wrong; marking them `status='rejected'`
        // keeps the engine's per-pair denylist from re-suggesting them.
        //
        // Rejection (not soft-delete) is the persistent USER-intent denylist:
        // soft-delete is the SYSTEM cascade for when a referenced transaction
        // itself is removed, and the per-pair denylist does NOT apply to
        // soft-deleted rows.
        client
            .query(
                &format!(
                    "UPDATE {TRANSACTION_PAIRS}
       SET {STATUS} = 'rejected', updated = CURRENT_TIMESTAMP
       WHERE {}
         AND ({IS_DELETED} IS NULL OR {IS_DELETED} = FALSE)
         AND {STATUS} = 'suggested'
         AND {PAIR_ID} <> $2
         AND ({TRANSACTION_ID_A} = $3 OR {TRANSACTION_ID_B} = $3
              OR {TRANSACTION_ID_A} = $4 OR {TRANSACTION_ID_B} = $4)",
                    shared_with_sql(USER_ID, "$1")
                ),
                &[
                    json!(user.user_id),
                    json!(effective_pair_id),
                    json!(canonical.transaction_id_a),
                    json!(canonical.transaction_id_b),
                ],
            )
            .await?;

        client.query("COMMIT", &[]).await?;
        Ok(PairResult::Ok { pair_id: effective_pair_id })
    })
    .await
}

/// Confirm a suggested transfer pair. Wrapped in a single DB transaction so
/// the lookup, collision pre-check, status update, and cleanup are atomic.
///
/// Invariants enforced:
///   - REJECT if either of the pair's transactions is already in ANOTHER
///     active confirmed pair. The data-integrity contract is "at most one
///     active confirmed pair per transaction": confirming the stale `(A, B)`
///     suggestion while `(A, C)` is already confirmed would violate that.
///   - On successful confirm, REJECT (status='rejected') any OTHER active
///     SUGGESTED pair involving the pair's transactions (engine-generated
///     alternatives for either half are now wrong, and the engine's per-pair
///     denylist remembers).
pub async fn confirm_transfer_pair(user: &MaskedUser, pair_id: &str) -> anyhow::Result<ConfirmResult> {
    let client = pool().connect().await?;
    confirm_transfer_pair_on(&client, user, pair_id).await
}

async fn confirm_transfer_pair_on(client: &dyn Executor, user: &MaskedUser, pair_id: &str) -> anyhow::Result<ConfirmResult> {
    or_rollback(client, async {
        client.query("BEGIN", &[]).await?;

        // A concurrent confirm of a different pair_id involving the same
        // transaction would otherwise slip past the collision SELECT.
        lock_transfer_pairs(client, &user.user_id).await?;

        // Look up the pair's transaction_ids. Missing, soft-deleted, or
        // rejection records all fail cleanly. The status filter blocks a
        // client from directly POSTing a rejected pair's pair_id to confirm
        // it.
        //
        // `FOR UPDATE` takes a row-level exclusive lock so a concurrent
        // pair-cascade of a transaction delete blocks until we commit:
        // without it the cascade could win the lookup→UPDATE gap and turn our
        // status UPDATE into a silent no-op.
        let lookup = client
            .query(
                &format!(
                    "SELECT {TRANSACTION_ID_A}, {TRANSACTION_ID_B} FROM {TRANSACTION_PAIRS}
       WHERE {PAIR_ID} = $1 AND {}
         AND ({IS_DELETED} IS NULL OR {IS_DELETED} = FALSE)
         AND {STATUS} <> 'rejected'
       FOR UPDATE",
                    shared_with_sql(USER_ID, "$2")
                ),
                &[json!(pair_id), json!(user.user_id)],
            )
            .await?;
        let found = if lookup.row_count.unwrap_or(0) == 0 { None } else { lookup.rows.first() };
        let Some(found) = found else {
            client.query("ROLLBACK", &[]).await?;
            return Ok(ConfirmResult::Failed { error: "Pair not found.".to_string() });
        };
        let transaction_id_a = value_of(found, TRANSACTION_ID_A);
        let transaction_id_b = value_of(found, TRANSACTION_ID_B);

        // Collision pre-check: is EITHER transaction already in ANOTHER
        // active confirmed pair?
        let collision = client
            .query(
                &format!(
                    "SELECT {PAIR_ID} FROM {TRANSACTION_PAIRS}
       WHERE {}
         AND {PAIR_ID} <> $2
         AND ({IS_DELETED} IS NULL OR {IS_DELETED} = FALSE)
         AND {STATUS} = 'confirmed'
         AND ({TRANSACTION_ID_A} = $3 OR {TRANSACTION_ID_B} = $3
              OR {TRANSACTION_ID_A} = $4 OR {TRANSACTION_ID_B} = $4)
       LIMIT 1",
                    shared_with_sql(USER_ID, "$1")
                ),
                &[json!(user.user_id), json!(pair_id), transaction_id_a.clone(), transaction_id_b.clone()],
            )
            .await?;
        if collision.row_count.unwrap_or(0) > 0 {
            client.query("ROLLBACK", &[]).await?;
            return Ok(ConfirmResult::Failed { error: ALREADY_PAIRED.to_string() });
        }

        client
            .query(
                &format!(
                    "UPDATE {TRANSACTION_PAIRS}
       SET {STATUS} = 'confirmed', updated = CURRENT_TIMESTAMP
       WHERE {PAIR_ID} = $1
         AND {}
         AND ({IS_DELETED} IS NULL OR {IS_DELETED} = FALSE)",
                    shared_with_sql(USER_ID, "$2")
                ),
                &[json!(pair_id), json!(user.user_id)],
            )
            .await?;

        // Cleanup: REJECT any OTHER active SUGGESTED pair involving the
        // pair's transactions. Same intent and mechanism as in
        // `pair_transactions`: confirming this pair implicitly rejects any
        // other engine suggestion for these transactions, and the engine's
        // per-pair denylist remembers the rejection persistently. Existing
        // rejected rows stay rejected (the filter scopes to
        // `status='suggested'`).
        client
            .query(
                &format!(
                    "UPDATE {TRANSACTION_PAIRS}
       SET {STATUS} = 'rejected', updated = CURRENT_TIMESTAMP
       WHERE {}
         AND {PAIR_ID} <> $2
         AND ({IS_DELETED} IS NULL OR {IS_DELETED} = FALSE)
         AND {STATUS} = 'suggested'
         AND ({TRANSACTION_ID_A} = $3 OR {TRANSACTION_ID_B} = $3
              OR {TRANSACTION_ID_A} = $4 OR {TRANSACTION_ID_B} = $4)",
                    shared_with_sql(USER_ID, "$1")
                ),
                &[json!(user.user_id), json!(pair_id), transaction_id_a, transaction_id_b],
            )
            .await?;

        client.query("COMMIT", &[]).await?;
        Ok(ConfirmResult::Ok)
    })
    .await
}

/// Reject a transfer pairing: marks the pair `status = 'rejected'` so the
/// suggestion engine remembers the user's "no" and won't re-suggest THIS
/// specific pair on future runs. The pair row stays present
/// (is_deleted = FALSE) so the rejection is queryable; the two transactions
/// remain eligible to be paired with OTHER counterparts.
///
/// Distinct from soft-deletion (`is_deleted = TRUE`): soft-deletion is the
/// system-side cascade when one of the paired transactions itself gets
/// removed (Plaid tombstone, manual delete). It has no user-intent semantics
/// and the surviving transaction is fully eligible for new suggestions,
/// including the same counterpart if it returns.
pub async fn reject_transfer_pair(user: &MaskedUser, pair_id: &str) -> anyhow::Result<()> {
    reject_transfer_pair_on(pool(), user, pair_id).await
}

async fn reject_transfer_pair_on(executor: &dyn Executor, user: &MaskedUser, pair_id: &str) -> anyhow::Result<()> {
    executor
        .query(
            &format!(
                "UPDATE {TRANSACTION_PAIRS}
     SET {STATUS} = 'rejected', updated = CURRENT_TIMESTAMP
     WHERE {PAIR_ID} = $1
       AND {}
       AND ({IS_DELETED} IS NULL OR {IS_DELETED} = FALSE)",
                shared_with_sql(USER_ID, "$2")
            ),
            &[json!(pair_id), json!(user.user_id)],
        )
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use regex::Regex;

    use super::super::transactions::testing::{obj, FakeExecutor};
    use super::*;

    fn matches(pattern: &str, text: &str) -> bool {
        Regex::new(pattern).unwrap().is_match(text)
    }

    fn user() -> MaskedUser {
        MaskedUser { user_id: "usr-1".into(), username: "tester".into() }
    }

    // `makePairRow` of `transfers.test.ts`.
    fn pair_json(overrides: Json) -> Json {
        let mut row = obj(json!({
            "pair_id": "pair-1",
            "user_id": "usr-1",
            "transaction_id_a": "tx-1",
            "transaction_id_b": "tx-2",
            "status": "suggested",
            "created_at": "2026-04-01T00:00:00Z",
            "updated": "2026-04-01T00:00:00Z",
            "is_deleted": false,
        }));
        row.extend(obj(overrides));
        Json::Object(row)
    }

    fn pair_row(overrides: Json) -> Row {
        transaction_pair::TABLE.validate(obj(pair_json(overrides))).unwrap()
    }

    // `makeTxRow` of `transfers.test.ts`.
    fn tx_json(transaction_id: &str) -> Json {
        json!({
            "transaction_id": transaction_id,
            "user_id": "usr-1",
            "account_id": "acc-1",
            "name": "Transfer Out",
            "merchant_name": null,
            "amount": 100,
            "iso_currency_code": "USD",
            "date": "2026-04-01",
            "pending": false,
            "pending_transaction_id": null,
            "payment_channel": "other",
            "location_country": null,
            "location_region": null,
            "location_city": null,
            "label_budget_id": null,
            "label_category_id": null,
            "label_memo": null,
            "label_category_confidence": null,
            "raw": null,
            "updated": "2026-04-01T00:00:00Z",
            "is_deleted": false,
            "source": "plaid",
        })
    }

    /// The transactions as the JSON the model gives, by id.
    fn transactions(ids: &[&str]) -> HashMap<String, Json> {
        ids.iter()
            .map(|id| (id.to_string(), transaction::to_json(&transaction::TABLE.validate(obj(tx_json(id))).unwrap())))
            .collect()
    }

    /// What `get_transfer_pairs` makes of the rows its two queries returned.
    fn assemble(all_pairs: &[Row], txn_by_id: &HashMap<String, Json>, include_deleted: bool) -> Vec<TransferPair> {
        let visible: Vec<&Row> = all_pairs.iter().filter(|pair| is_visible(pair)).collect();
        let evictions =
            if include_deleted { all_pairs.iter().filter(|pair| !is_visible(pair)).map(to_eviction).collect() } else { Vec::new() };
        resolve_pairs(&visible, txn_by_id, include_deleted, evictions)
    }

    fn ids(pairs: &[TransferPair]) -> Vec<&str> {
        pairs.iter().map(|pair| pair["pair_id"].as_str().unwrap()).collect()
    }

    fn statements(executor: &FakeExecutor) -> Vec<String> {
        executor.calls().into_iter().map(|(sql, _)| sql).collect()
    }

    /// The call whose statement matches `pattern`, if any.
    fn call_matching(executor: &FakeExecutor, pattern: &str) -> Option<(String, Vec<Json>)> {
        executor.calls().into_iter().find(|(sql, _)| matches(pattern, sql))
    }

    fn has(executor: &FakeExecutor, pattern: &str) -> bool {
        call_matching(executor, pattern).is_some()
    }

    // getTransferPairs

    #[tokio::test]
    async fn no_pairs_means_no_transactions_query() {
        let executor = FakeExecutor::new().rows(vec![]);
        let result = get_transfer_pairs_on(&executor, &user(), GetTransferPairsOptions::default()).await.unwrap();
        assert!(result.is_empty());
        assert_eq!(executor.calls().len(), 1);
    }

    #[tokio::test]
    async fn loads_paired_transactions_and_returns_one_entry_per_pair() {
        let executor = FakeExecutor::new()
            .rows(vec![pair_json(json!({ "status": "confirmed" }))])
            .rows(vec![tx_json("tx-1"), tx_json("tx-2")]);
        let result = get_transfer_pairs_on(&executor, &user(), GetTransferPairsOptions::default()).await.unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["pair_id"], "pair-1");
        assert_eq!(result[0]["status"], "confirmed");
        assert_eq!(result[0]["transactions"].as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn drops_a_pair_whose_transactions_are_not_retrievable() {
        let executor =
            FakeExecutor::new().rows(vec![pair_json(json!({ "transaction_id_b": "tx-MISSING" }))]).rows(vec![tx_json("tx-1")]);
        let result = get_transfer_pairs_on(&executor, &user(), GetTransferPairsOptions::default()).await.unwrap();
        assert!(result.is_empty());
    }

    #[tokio::test]
    async fn both_queries_read_the_sharing_group() {
        let executor = FakeExecutor::new().rows(vec![pair_json(json!({}))]).rows(vec![tx_json("tx-1"), tx_json("tx-2")]);
        get_transfer_pairs_on(&executor, &user(), GetTransferPairsOptions::default()).await.unwrap();
        for index in [0, 1] {
            assert!(executor.sql(index).contains("WHERE user_id = ANY(sharing_user_ids($1))"), "{}", executor.sql(index));
            assert!(executor.values(index).contains(&json!("usr-1")));
        }
        assert_eq!(
            executor.sql(0),
            "SELECT * FROM transaction_pairs WHERE user_id = ANY(sharing_user_ids($1)) AND (is_deleted IS NULL OR is_deleted = FALSE) ORDER BY pair_id"
        );
        assert_eq!(executor.values(1), vec![json!("usr-1"), json!("tx-1"), json!("tx-2")]);
    }

    #[tokio::test]
    async fn the_cursor_and_evictions_shape_the_pair_query() {
        let executor = FakeExecutor::new().rows(vec![]);
        let options = GetTransferPairsOptions { include_deleted: true, start_date: Some("2026-01-01".into()) };
        get_transfer_pairs_on(&executor, &user(), options).await.unwrap();
        assert_eq!(
            executor.sql(0),
            "SELECT * FROM transaction_pairs WHERE user_id = ANY(sharing_user_ids($1)) AND updated >= $2 ORDER BY pair_id"
        );
        assert_eq!(executor.values(0), vec![json!("usr-1"), json!("2026-01-01")]);

        // An empty cursor narrows nothing.
        let executor = FakeExecutor::new().rows(vec![]);
        let options = GetTransferPairsOptions { include_deleted: false, start_date: Some(String::new()) };
        get_transfer_pairs_on(&executor, &user(), options).await.unwrap();
        assert_eq!(executor.values(0), vec![json!("usr-1")]);
    }

    #[test]
    fn a_pair_carries_its_two_transactions_in_a_then_b_order() {
        let pairs = [pair_row(json!({ "status": "confirmed", "transaction_id_a": "tx-2", "transaction_id_b": "tx-1" }))];
        let result = assemble(&pairs, &transactions(&["tx-1", "tx-2"]), false);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["updated"], "2026-04-01T00:00:00Z");
        let members: Vec<&str> =
            result[0]["transactions"].as_array().unwrap().iter().map(|t| t["transaction_id"].as_str().unwrap()).collect();
        assert_eq!(members, ["tx-2", "tx-1"]);
        let keys: Vec<&String> = result[0].as_object().unwrap().keys().collect();
        assert_eq!(keys, ["pair_id", "status", "transactions", "updated"]);
    }

    #[test]
    fn a_pair_missing_a_half_is_dropped_and_evicted_only_on_request() {
        let pairs = [pair_row(json!({ "transaction_id_b": "tx-MISSING" }))];
        let txns = transactions(&["tx-1"]);
        assert!(assemble(&pairs, &txns, false).is_empty());
        assert_eq!(
            assemble(&pairs, &txns, true),
            [json!({ "pair_id": "pair-1", "status": "suggested", "transactions": [], "updated": "2026-04-01T00:00:00Z" })]
        );
    }

    #[test]
    fn rejected_and_deleted_pairs_are_hidden() {
        assert!(is_visible(&pair_row(json!({}))));
        assert!(is_visible(&pair_row(json!({ "status": "confirmed", "is_deleted": null }))));
        assert!(!is_visible(&pair_row(json!({ "status": "rejected" }))));
        assert!(!is_visible(&pair_row(json!({ "is_deleted": true }))));
    }

    #[test]
    fn active_pairs_come_first_then_hidden_ones_then_unresolved_ones() {
        let pairs = [
            pair_row(json!({ "pair_id": "p1", "status": "rejected" })),
            pair_row(json!({ "pair_id": "p2", "transaction_id_a": "tx-gone", "transaction_id_b": "tx-1" })),
            pair_row(json!({ "pair_id": "p3", "status": "confirmed" })),
            pair_row(json!({ "pair_id": "p4", "is_deleted": true, "updated": null })),
        ];
        let txns = transactions(&["tx-1", "tx-2"]);

        let delta = assemble(&pairs, &txns, true);
        assert_eq!(ids(&delta), ["p3", "p1", "p4", "p2"]);
        assert_eq!(delta[0]["transactions"].as_array().unwrap().len(), 2);
        assert_eq!(delta[1], json!({ "pair_id": "p1", "status": "rejected", "transactions": [], "updated": "2026-04-01T00:00:00Z" }));
        assert_eq!(delta[2], json!({ "pair_id": "p4", "status": "suggested", "transactions": [], "updated": null }));

        // Without eviction signals the hidden and unresolved pairs are simply left out.
        assert_eq!(ids(&assemble(&pairs, &txns, false)), ["p3"]);
    }

    // pairTransactions. Stages: BEGIN, membership lock, transfer lock,
    // existence pre-check (FOR SHARE), collision SELECT, INSERT, cleanup
    // UPDATE, COMMIT (8 calls). A refusal replaces what follows it with a
    // ROLLBACK.

    fn ab_owned_by(owner_a: &str, owner_b: &str) -> Vec<Json> {
        vec![json!({ "transaction_id": "tx-a", "user_id": owner_a }), json!({ "transaction_id": "tx-b", "user_id": owner_b })]
    }

    fn stage_opening() -> FakeExecutor {
        FakeExecutor::new().count(0).rows(vec![json!({})]).rows(vec![json!({})])
    }

    fn stage_pair_ok(insert_pair_id: &str, collision: Vec<Json>, transactions: Vec<Json>) -> FakeExecutor {
        stage_opening()
            .rows(transactions)
            .rows(collision)
            .rows(vec![json!({ "pair_id": insert_pair_id })])
            .count(0)
            .count(0)
    }

    async fn pair(executor: &FakeExecutor, a: &str, b: &str, status: &str) -> PairResult {
        pair_transactions_on(executor, &user(), "pair-generated", a, b, status).await.unwrap()
    }

    const INSERT: &str = r"(?i)INSERT INTO transaction_pairs";

    #[tokio::test]
    async fn pairing_inserts_and_returns_the_effective_pair_id() {
        let executor = stage_pair_ok("pair-new", vec![], ab_owned_by("usr-1", "usr-1"));
        assert_eq!(pair(&executor, "tx-a", "tx-b", "suggested").await, PairResult::Ok { pair_id: "pair-new".into() });
        assert_eq!(executor.calls().len(), 8);
        let (_, values) = call_matching(&executor, INSERT).unwrap();
        assert_eq!(values, vec![json!("pair-generated"), json!("usr-1"), json!("tx-a"), json!("tx-b"), json!("suggested")]);
        assert_eq!(statements(&executor)[7], "COMMIT");
    }

    #[tokio::test]
    async fn a_duplicate_pair_undeletes_the_existing_row() {
        let executor = stage_pair_ok("pair-existing", vec![], ab_owned_by("usr-1", "usr-1"));
        assert_eq!(pair(&executor, "tx-a", "tx-b", "suggested").await, PairResult::Ok { pair_id: "pair-existing".into() });
        let (sql, _) = call_matching(&executor, INSERT).unwrap();
        assert!(sql.contains("ON CONFLICT (transaction_id_a, transaction_id_b)"));
        assert!(sql.contains("is_deleted = FALSE"));
        assert!(matches(r"CASE\s+WHEN\s+transaction_pairs\.is_deleted\s*=\s*TRUE\s+THEN\s+EXCLUDED\.status", &sql));
    }

    #[tokio::test]
    async fn the_pair_belongs_to_the_owner_of_its_first_transaction_whoever_in_the_group_asked() {
        let rows = vec![json!({ "transaction_id": "tx-b", "user_id": "usr-3" }), json!({ "transaction_id": "tx-a", "user_id": "usr-2" })];
        for (first, second) in [("tx-a", "tx-b"), ("tx-b", "tx-a")] {
            let executor = stage_pair_ok("pair-shared", vec![], rows.clone());
            pair(&executor, first, second, "suggested").await;
            let (_, values) = call_matching(&executor, INSERT).unwrap();
            assert_eq!(values[1..], [json!("usr-2"), json!("tx-a"), json!("tx-b"), json!("suggested")]);
        }
    }

    #[tokio::test]
    async fn pairing_refuses_rows_that_are_not_the_two_transactions_asked_for() {
        let executor = stage_opening()
            .rows(vec![json!({ "transaction_id": "tx-a", "user_id": "usr-1" }), json!({ "transaction_id": "tx-other", "user_id": "usr-1" })])
            .count(0);
        assert!(matches!(pair(&executor, "tx-a", "tx-b", "suggested").await, PairResult::Failed { .. }));
        assert!(!has(&executor, INSERT));
    }

    #[tokio::test]
    async fn one_transaction_paired_with_itself_passes_the_existence_check() {
        let executor = stage_pair_ok("pair-self", vec![], vec![json!({ "transaction_id": "tx-a", "user_id": "usr-1" })]);
        assert_eq!(pair(&executor, "tx-a", "tx-a", "suggested").await, PairResult::Ok { pair_id: "pair-self".into() });
    }

    #[tokio::test]
    async fn reversed_ids_reach_the_same_row_shape() {
        let rows = vec![json!({ "transaction_id": "tx-a", "user_id": "usr-1" }), json!({ "transaction_id": "tx-z", "user_id": "usr-1" })];
        let executor = stage_pair_ok("pair-1", vec![], rows);
        pair(&executor, "tx-z", "tx-a", "suggested").await;
        let (_, values) = call_matching(&executor, INSERT).unwrap();
        assert_eq!(values[2..4], [json!("tx-a"), json!("tx-z")]);
    }

    #[tokio::test]
    async fn pairing_accepts_confirmed_status() {
        let executor = stage_pair_ok("pair-1", vec![], ab_owned_by("usr-1", "usr-1"));
        pair(&executor, "tx-a", "tx-b", "confirmed").await;
        let (_, values) = call_matching(&executor, INSERT).unwrap();
        assert_eq!(values[4], json!("confirmed"));
    }

    #[tokio::test]
    async fn pairing_refuses_a_missing_transaction_and_rolls_back() {
        for alive in ["tx-a", "tx-b"] {
            let executor = stage_opening().rows(vec![json!({ "transaction_id": alive, "user_id": "usr-1" })]).count(0);
            let PairResult::Failed { error } = pair(&executor, "tx-a", "tx-b", "suggested").await else { panic!("paired") };
            assert_eq!(error, "One or both transactions no longer exist (deleted or never belonged to this user).");
            assert!(!has(&executor, INSERT));
            assert_eq!(statements(&executor).last().unwrap(), "ROLLBACK");
            assert_eq!(executor.calls().len(), 5);
        }
    }

    #[tokio::test]
    async fn pairing_refuses_a_transaction_already_in_another_confirmed_pair() {
        let executor = stage_opening()
            .rows(ab_owned_by("usr-1", "usr-1"))
            .rows(vec![json!({ "pair_id": "pair-existing-confirmed" })])
            .count(0);
        assert_eq!(pair(&executor, "tx-a", "tx-b", "suggested").await, PairResult::Failed { error: ALREADY_PAIRED.into() });
        assert!(!has(&executor, INSERT));
        let sqls = statements(&executor);
        assert_eq!(sqls.last().unwrap(), "ROLLBACK");
        assert!(!sqls.contains(&"COMMIT".to_string()));
    }

    #[tokio::test]
    async fn the_existence_check_reads_the_sharing_group_alive_and_for_share() {
        let executor = stage_pair_ok("pair-new", vec![], ab_owned_by("usr-1", "usr-1"));
        pair(&executor, "tx-a", "tx-b", "suggested").await;
        let (sql, values) = call_matching(&executor, r"(?i)SELECT transaction_id, user_id FROM transactions").unwrap();
        assert!(matches(r"WHERE user_id = ANY\(sharing_user_ids\(\$1\)\)\s+AND ", &sql));
        assert!(matches(r"transaction_id = ANY\(\$2", &sql));
        assert!(sql.contains("is_deleted IS NULL OR is_deleted = FALSE"));
        assert!(sql.contains("FOR SHARE"));
        assert_eq!(values, vec![json!("usr-1"), json!(["tx-a", "tx-b"])]);
    }

    #[tokio::test]
    async fn the_collision_check_leaves_out_the_pair_being_re_paired() {
        let executor = stage_pair_ok("pair-rejected-reactivated", vec![], ab_owned_by("usr-1", "usr-1"));
        pair(&executor, "tx-a", "tx-b", "suggested").await;
        let (sql, _) = call_matching(&executor, r"(?i)SELECT pair_id FROM transaction_pairs[\s\S]*status = 'confirmed'").unwrap();
        assert!(sql.contains("NOT (transaction_id_a = $4 AND transaction_id_b = $5)"));
        assert!(sql.contains("WHERE user_id = ANY(sharing_user_ids($1))"));
    }

    #[tokio::test]
    async fn pairing_rejects_the_other_suggestions_of_both_halves() {
        let executor = stage_pair_ok("pair-new", vec![], ab_owned_by("usr-1", "usr-1"));
        pair(&executor, "tx-a", "tx-b", "suggested").await;
        let (sql, values) =
            call_matching(&executor, r"(?i)UPDATE transaction_pairs[\s\S]*SET\s+status\s*=\s*'rejected'[\s\S]*status = 'suggested'")
                .unwrap();
        assert!(sql.contains("pair_id <> $2"));
        assert!(sql.contains("WHERE user_id = ANY(sharing_user_ids($1))"));
        assert!(!matches(r"(?i)is_deleted\s*=\s*TRUE", &sql));
        assert_eq!(values, vec![json!("usr-1"), json!("pair-new"), json!("tx-a"), json!("tx-b")]);
    }

    #[tokio::test]
    async fn a_failed_statement_rolls_back_and_is_passed_on() {
        let executor = stage_opening().failure("existence failed").count(0);
        let error = pair_transactions_on(&executor, &user(), "p", "tx-a", "tx-b", "suggested").await.unwrap_err();
        assert_eq!(error.to_string(), "existence failed");
        assert_eq!(statements(&executor).last().unwrap(), "ROLLBACK");

        // A ROLLBACK that fails too is the failure passed on.
        let executor = stage_opening().failure("existence failed").failure("rollback failed");
        let error = pair_transactions_on(&executor, &user(), "p", "tx-a", "tx-b", "suggested").await.unwrap_err();
        assert_eq!(error.to_string(), "rollback failed");
    }

    // confirmTransferPair. Stages: BEGIN, membership lock, transfer lock,
    // lookup SELECT, collision SELECT, UPDATE confirmed, cleanup UPDATE,
    // COMMIT (8 calls).

    fn stage_confirm_ok(a: &str, b: &str) -> FakeExecutor {
        stage_opening()
            .rows(vec![json!({ "transaction_id_a": a, "transaction_id_b": b })])
            .rows(vec![])
            .count(1)
            .count(0)
            .count(0)
    }

    const CONFIRM_UPDATE: &str = r"(?i)UPDATE transaction_pairs[\s\S]*'confirmed'";

    #[tokio::test]
    async fn confirming_updates_the_pair_by_id() {
        let executor = stage_confirm_ok("tx-a", "tx-b");
        assert_eq!(confirm_transfer_pair_on(&executor, &user(), "pair-1").await.unwrap(), ConfirmResult::Ok);
        assert_eq!(executor.calls().len(), 8);
        let (sql, values) = call_matching(&executor, CONFIRM_UPDATE).unwrap();
        assert!(sql.contains("AND user_id = ANY(sharing_user_ids($2))"));
        assert_eq!(values, vec![json!("pair-1"), json!("usr-1")]);
        assert_eq!(statements(&executor)[7], "COMMIT");
    }

    #[tokio::test]
    async fn confirming_a_missing_pair_fails_and_rolls_back() {
        let executor = stage_opening().rows(vec![]).count(0);
        let result = confirm_transfer_pair_on(&executor, &user(), "pair-missing").await.unwrap();
        assert_eq!(result, ConfirmResult::Failed { error: "Pair not found.".into() });
        assert!(!has(&executor, CONFIRM_UPDATE));
        assert_eq!(statements(&executor).last().unwrap(), "ROLLBACK");
    }

    #[tokio::test]
    async fn confirming_refuses_a_transaction_already_in_another_confirmed_pair() {
        let executor = stage_opening()
            .rows(vec![json!({ "transaction_id_a": "tx-a", "transaction_id_b": "tx-b" })])
            .rows(vec![json!({ "pair_id": "pair-colliding-confirmed" })])
            .count(0);
        let result = confirm_transfer_pair_on(&executor, &user(), "pair-1").await.unwrap();
        assert_eq!(result, ConfirmResult::Failed { error: ALREADY_PAIRED.into() });
        assert!(!has(&executor, CONFIRM_UPDATE));
        assert_eq!(statements(&executor).last().unwrap(), "ROLLBACK");
        assert_eq!(executor.values(4), vec![json!("usr-1"), json!("pair-1"), json!("tx-a"), json!("tx-b")]);
    }

    #[tokio::test]
    async fn the_lookup_leaves_out_rejected_pairs() {
        let executor = stage_confirm_ok("tx-a", "tx-b");
        confirm_transfer_pair_on(&executor, &user(), "pair-1").await.unwrap();
        let (sql, values) = call_matching(&executor, r"(?i)SELECT transaction_id_a, transaction_id_b FROM transaction_pairs").unwrap();
        assert!(sql.contains("status <> 'rejected'"));
        assert!(sql.contains("WHERE pair_id = $1 AND user_id = ANY(sharing_user_ids($2))"));
        assert!(sql.contains("FOR UPDATE"));
        assert_eq!(values, vec![json!("pair-1"), json!("usr-1")]);
    }

    #[tokio::test]
    async fn confirming_rejects_the_other_suggestions_of_both_halves() {
        let executor = stage_confirm_ok("tx-a", "tx-b");
        confirm_transfer_pair_on(&executor, &user(), "pair-1").await.unwrap();
        let (sql, values) =
            call_matching(&executor, r"(?i)UPDATE transaction_pairs[\s\S]*SET\s+status\s*=\s*'rejected'[\s\S]*status = 'suggested'")
                .unwrap();
        assert!(sql.contains("pair_id <> $2"));
        assert!(!matches(r"(?i)is_deleted\s*=\s*TRUE", &sql));
        assert_eq!(values, vec![json!("usr-1"), json!("pair-1"), json!("tx-a"), json!("tx-b")]);
    }

    // rejectTransferPair

    #[tokio::test]
    async fn rejecting_sets_the_status_and_keeps_the_row() {
        let executor = FakeExecutor::new().count(1);
        reject_transfer_pair_on(&executor, &user(), "pair-1").await.unwrap();
        assert_eq!(executor.calls().len(), 1);
        let sql = executor.sql(0);
        assert!(sql.contains("UPDATE transaction_pairs"));
        assert!(sql.contains("status = 'rejected'"));
        assert!(!sql.contains("is_deleted = TRUE"));
        assert!(sql.contains("is_deleted IS NULL OR is_deleted = FALSE"));
        assert!(sql.contains("AND user_id = ANY(sharing_user_ids($2))"));
        assert_eq!(executor.values(0), vec![json!("pair-1"), json!("usr-1")]);
    }

    // "transfer-pair writes lock the sharing membership, then the group"

    fn opening(executor: &FakeExecutor) -> Vec<(String, Vec<Json>)> {
        let whitespace = Regex::new(r"\s+").unwrap();
        executor.calls().into_iter().take(3).map(|(sql, values)| (whitespace.replace_all(&sql, " ").trim().to_string(), values)).collect()
    }

    fn expected_opening() -> Vec<(String, Vec<Json>)> {
        vec![
            ("BEGIN".to_string(), vec![]),
            ("SELECT pg_advisory_xact_lock_shared(hashtext('sharing'))".to_string(), vec![]),
            (
                "SELECT pg_advisory_xact_lock(hashtext((SELECT min(member::text) FROM unnest(sharing_user_ids($1)) member) || ':transfers'))"
                    .to_string(),
                vec![json!("usr-1")],
            ),
        ]
    }

    #[tokio::test]
    async fn pairing_locks_the_sharing_membership_then_the_group() {
        let executor = stage_pair_ok("pair-new", vec![], ab_owned_by("usr-1", "usr-1"));
        pair(&executor, "tx-a", "tx-b", "suggested").await;
        assert_eq!(opening(&executor), expected_opening());
    }

    #[tokio::test]
    async fn confirming_locks_the_sharing_membership_then_the_group() {
        let executor = stage_confirm_ok("tx-a", "tx-b");
        confirm_transfer_pair_on(&executor, &user(), "pair-1").await.unwrap();
        assert_eq!(opening(&executor), expected_opening());
    }

    // A route handler is a boxed `Send` future, so what it awaits has to be `Send` too.
    #[test]
    fn the_futures_can_be_awaited_from_a_route() {
        fn assert_send<T: Send>(_future: T) {}
        let user = user();
        assert_send(get_transfer_pairs(&user, GetTransferPairsOptions::default()));
        assert_send(pair_transactions(&user, "tx-1", "tx-2", None));
        assert_send(confirm_transfer_pair(&user, "pair-1"));
        assert_send(reject_transfer_pair(&user, "pair-1"));
        assert_send(lock_transfer_pairs(pool(), "usr-1"));
    }

    #[test]
    fn results_are_the_objects_the_typescript_returns() {
        assert_eq!(
            crate::js::json_stringify(&PairResult::Ok { pair_id: "p".into() }.to_json()),
            r#"{"ok":true,"pair_id":"p"}"#
        );
        assert_eq!(
            crate::js::json_stringify(&PairResult::Failed { error: "no".into() }.to_json()),
            r#"{"ok":false,"error":"no"}"#
        );
        assert_eq!(crate::js::json_stringify(&ConfirmResult::Ok.to_json()), r#"{"ok":true}"#);
        assert_eq!(
            crate::js::json_stringify(&ConfirmResult::Failed { error: "Pair not found.".into() }.to_json()),
            r#"{"ok":false,"error":"Pair not found."}"#
        );
    }
}
