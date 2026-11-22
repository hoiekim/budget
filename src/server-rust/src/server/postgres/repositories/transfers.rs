//! `src/server/lib/postgres/repositories/transfers.ts`.

use std::collections::HashMap;
use std::future::Future;

use serde_json::json;

use crate::common::constants::{TRANSACTIONS, TRANSACTION_PAIRS};
use crate::filters;
use crate::js::{truthy_opt, Json, Obj};
use crate::server::postgres::client::{pool, Client, Executor};
use crate::server::postgres::database::{DateRange, SearchFilters};
use crate::server::postgres::models::base::{str_of, value_of};
use crate::server::postgres::models::common::{
    IS_DELETED, PAIR_ID, STATUS, TRANSACTION_ID, TRANSACTION_ID_A, TRANSACTION_ID_B, UPDATED, USER_ID,
};
use crate::server::postgres::models::transaction_pair::canonicalize_pair_ids;
use crate::server::postgres::models::{transaction, transaction_pair, MaskedUser, Row};

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

/// Get all transfer pairs for a user. Resolves the two transactions each
/// pair references so the response keeps one entry per pair, with the two
/// paired transactions inline.
pub async fn get_transfer_pairs(user: &MaskedUser, options: GetTransferPairsOptions) -> anyhow::Result<Vec<TransferPair>> {
    // `Table::query` excludes soft-deleted rows by default. When the caller
    // opts into tombstone delivery, keep them by unsetting the exclusion,
    // matching the transactions/snapshots delta-delivery contract.
    // `start_date` narrows the SQL scan to rows whose `updated >= $cursor`, so
    // a warm sync fetches only the delta instead of the full pair set.
    let all_pairs = transaction_pair::TABLE
        .query(
            filters! { USER_ID => user.user_id.as_str() },
            SearchFilters {
                order_by: Some(PAIR_ID.to_string()),
                exclude_deleted: Some(!options.include_deleted),
                date_range: options
                    .start_date
                    .filter(|start| !start.is_empty())
                    .map(|start| DateRange { column: UPDATED.to_string(), start: Some(start), end: None }),
                ..Default::default()
            },
            None,
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
            filters! { USER_ID => user.user_id.as_str() },
            SearchFilters { in_filters: vec![(TRANSACTION_ID.to_string(), txn_ids)], ..Default::default() },
            None,
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
async fn or_rollback<T>(client: &Client, work: impl Future<Output = anyhow::Result<T>>) -> anyhow::Result<T> {
    match work.await {
        Ok(value) => Ok(value),
        Err(error) => {
            client.query("ROLLBACK", &[]).await?;
            Err(error)
        }
    }
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
    let canonical = canonicalize_pair_ids(transaction_id_a, transaction_id_b);

    let client = pool().connect().await?;
    or_rollback(&client, async {
        client.query("BEGIN", &[]).await?;

        // Per-user serialization for all transfer-pair mutations via a
        // transaction-scoped advisory lock. Without it, two concurrent calls
        // (double-click, two tabs) can each pass the collision SELECT before
        // either commits (READ COMMITTED hides the in-flight UPDATE) and both
        // succeed, leaving A in two simultaneous active confirmed pairs.
        // Per-user scope so users only contend with themselves.
        client.query("SELECT pg_advisory_xact_lock(hashtext($1 || ':transfers'))", &[json!(user.user_id)]).await?;

        // Existence pre-check: BOTH transactions must exist, be alive, and
        // belong to this user. `FOR SHARE` takes a row-level share lock that
        // conflicts with the EXCLUSIVE lock a delete of the transaction
        // takes, serializing the existence check against any concurrent
        // delete: without it, a delete could commit between our SELECT and
        // INSERT, leaving a confirmed pair referencing a soft-deleted
        // transaction. Returns 0/1/2 rows; we expect 2.
        let existence = client
            .query(
                &format!(
                    "SELECT {TRANSACTION_ID} FROM {TRANSACTIONS}
       WHERE {USER_ID} = $1
         AND {TRANSACTION_ID} = ANY($2::text[])
         AND ({IS_DELETED} IS NULL OR {IS_DELETED} = FALSE)
       FOR SHARE"
                ),
                &[json!(user.user_id), json!([canonical.transaction_id_a, canonical.transaction_id_b])],
            )
            .await?;
        if existence.row_count.unwrap_or(0) != 2 {
            client.query("ROLLBACK", &[]).await?;
            return Ok(PairResult::Failed {
                error: "One or both transactions no longer exist (deleted or never belonged to this user).".to_string(),
            });
        }

        // Collision pre-check: is EITHER transaction in another active
        // confirmed pair with a different counterparty? If so, refuse:
        // confirming would put the transaction in two simultaneous confirmed
        // pairs.
        let collision = client
            .query(
                &format!(
                    "SELECT {PAIR_ID} FROM {TRANSACTION_PAIRS}
       WHERE {USER_ID} = $1
         AND ({IS_DELETED} IS NULL OR {IS_DELETED} = FALSE)
         AND {STATUS} = 'confirmed'
         AND ({TRANSACTION_ID_A} = $2 OR {TRANSACTION_ID_B} = $2
              OR {TRANSACTION_ID_A} = $3 OR {TRANSACTION_ID_B} = $3)
         AND NOT ({TRANSACTION_ID_A} = $4 AND {TRANSACTION_ID_B} = $5)
       LIMIT 1"
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
            return Ok(PairResult::Failed {
                error: "One of these transactions is already in another confirmed transfer pair. Reject or unpair the existing pair first."
                    .to_string(),
            });
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
                    json!(user.user_id),
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
       WHERE {USER_ID} = $1
         AND ({IS_DELETED} IS NULL OR {IS_DELETED} = FALSE)
         AND {STATUS} = 'suggested'
         AND {PAIR_ID} <> $2
         AND ({TRANSACTION_ID_A} = $3 OR {TRANSACTION_ID_B} = $3
              OR {TRANSACTION_ID_A} = $4 OR {TRANSACTION_ID_B} = $4)"
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
    or_rollback(&client, async {
        client.query("BEGIN", &[]).await?;

        // Per-user advisory lock: see the comment in `pair_transactions`.
        // Same race-window concern: a concurrent confirm of a different
        // pair_id involving the same transaction would slip past the
        // collision SELECT.
        client.query("SELECT pg_advisory_xact_lock(hashtext($1 || ':transfers'))", &[json!(user.user_id)]).await?;

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
       WHERE {PAIR_ID} = $1 AND {USER_ID} = $2
         AND ({IS_DELETED} IS NULL OR {IS_DELETED} = FALSE)
         AND {STATUS} <> 'rejected'
       FOR UPDATE"
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
       WHERE {USER_ID} = $1
         AND {PAIR_ID} <> $2
         AND ({IS_DELETED} IS NULL OR {IS_DELETED} = FALSE)
         AND {STATUS} = 'confirmed'
         AND ({TRANSACTION_ID_A} = $3 OR {TRANSACTION_ID_B} = $3
              OR {TRANSACTION_ID_A} = $4 OR {TRANSACTION_ID_B} = $4)
       LIMIT 1"
                ),
                &[json!(user.user_id), json!(pair_id), transaction_id_a.clone(), transaction_id_b.clone()],
            )
            .await?;
        if collision.row_count.unwrap_or(0) > 0 {
            client.query("ROLLBACK", &[]).await?;
            return Ok(ConfirmResult::Failed {
                error: "One of these transactions is already in another confirmed transfer pair. Reject or unpair the existing pair first."
                    .to_string(),
            });
        }

        client
            .query(
                &format!(
                    "UPDATE {TRANSACTION_PAIRS}
       SET {STATUS} = 'confirmed', updated = CURRENT_TIMESTAMP
       WHERE {PAIR_ID} = $1
         AND {USER_ID} = $2
         AND ({IS_DELETED} IS NULL OR {IS_DELETED} = FALSE)"
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
       WHERE {USER_ID} = $1
         AND {PAIR_ID} <> $2
         AND ({IS_DELETED} IS NULL OR {IS_DELETED} = FALSE)
         AND {STATUS} = 'suggested'
         AND ({TRANSACTION_ID_A} = $3 OR {TRANSACTION_ID_B} = $3
              OR {TRANSACTION_ID_A} = $4 OR {TRANSACTION_ID_B} = $4)"
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
    pool()
        .query(
            &format!(
                "UPDATE {TRANSACTION_PAIRS}
     SET {STATUS} = 'rejected', updated = CURRENT_TIMESTAMP
     WHERE {PAIR_ID} = $1
       AND {USER_ID} = $2
       AND ({IS_DELETED} IS NULL OR {IS_DELETED} = FALSE)"
            ),
            &[json!(pair_id), json!(user.user_id)],
        )
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(value: Json) -> Obj {
        match value {
            Json::Object(map) => map,
            other => panic!("not an object: {other}"),
        }
    }

    // `makePairRow` of `transfers.test.ts`.
    fn pair_row(overrides: Json) -> Row {
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
        transaction_pair::TABLE.validate(row).unwrap()
    }

    // `makeTxRow` of `transfers.test.ts`, as the JSON the model gives.
    fn transactions(ids: &[&str]) -> HashMap<String, Json> {
        ids.iter()
            .map(|id| {
                let row = obj(json!({
                    "transaction_id": id,
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
                }));
                (id.to_string(), transaction::to_json(&transaction::TABLE.validate(row).unwrap()))
            })
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

    // "loads paired transactions and returns one entry per pair"
    #[test]
    fn a_pair_carries_its_two_transactions_in_a_then_b_order() {
        let pairs = [pair_row(json!({ "status": "confirmed", "transaction_id_a": "tx-2", "transaction_id_b": "tx-1" }))];
        let result = assemble(&pairs, &transactions(&["tx-1", "tx-2"]), false);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["pair_id"], "pair-1");
        assert_eq!(result[0]["status"], "confirmed");
        assert_eq!(result[0]["updated"], "2026-04-01T00:00:00Z");
        let members: Vec<&str> =
            result[0]["transactions"].as_array().unwrap().iter().map(|t| t["transaction_id"].as_str().unwrap()).collect();
        assert_eq!(members, ["tx-2", "tx-1"]);
        let keys: Vec<&String> = result[0].as_object().unwrap().keys().collect();
        assert_eq!(keys, ["pair_id", "status", "transactions", "updated"]);
    }

    // "drops a pair whose transactions are not retrievable (e.g. soft-deleted)"
    #[test]
    fn a_pair_missing_a_half_is_dropped_and_evicted_only_on_request() {
        let pairs = [pair_row(json!({ "transaction_id_b": "tx-MISSING" }))];
        let txns = transactions(&["tx-1"]);
        assert!(assemble(&pairs, &txns, false).is_empty());

        let evicted = assemble(&pairs, &txns, true);
        assert_eq!(
            evicted,
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

    // A route handler is a boxed `Send` future, so what it awaits has to be `Send` too.
    #[test]
    fn the_futures_can_be_awaited_from_a_route() {
        fn assert_send<T: Send>(_future: T) {}
        let user = MaskedUser { user_id: "usr-1".into(), username: "tester".into() };
        assert_send(get_transfer_pairs(&user, GetTransferPairsOptions::default()));
        assert_send(pair_transactions(&user, "tx-1", "tx-2", None));
        assert_send(confirm_transfer_pair(&user, "pair-1"));
        assert_send(reject_transfer_pair(&user, "pair-1"));
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
