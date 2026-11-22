//! Suggests transfer pairs between a user's accounts, or between the accounts
//! of people who share data: `src/server/lib/compute-tools/detect-transfers.ts`.

use std::collections::HashSet;

use serde_json::json;

use crate::common::constants::TRANSFER_DATE_WINDOW_DAYS;
use crate::ctx;
use crate::js::{Json, Obj};
use crate::server::logger;
use crate::server::postgres::client::{pool, Client, Executor};
use crate::server::postgres::database::SearchFilters;
use crate::server::postgres::models::base::str_of;
use crate::server::postgres::models::transaction_pair::canonicalize_pair_ids;
use crate::server::postgres::models::user;
use crate::server::postgres::repositories::sharing::get_sharing_user_ids;
use crate::server::postgres::repositories::transfers::lock_transfer_pairs;

use super::detect_recurrings::number_of;

const BASE_CONFIDENCE: f64 = 0.7;
const PLAID_TRANSFER_BOOST: f64 = 0.2;
const SAME_DAY_BOOST: f64 = 0.1;
const SUGGEST_THRESHOLD: f64 = 0.7;
/// Kept under the local name the SQL comments and docs use.
const DATE_WINDOW_DAYS: i64 = TRANSFER_DATE_WINDOW_DAYS;
const PER_USER_CANDIDATE_LIMIT: i64 = 500;

/// One candidate pair, the TypeScript `DetectionCandidate`.
#[derive(Clone, Debug, PartialEq)]
pub struct DetectionCandidate {
    pub transaction_id_a: String,
    pub transaction_id_b: String,
    /// Who owns `transaction_id_a`: one of the people the run covers.
    pub user_id_a: String,
    /// Who owns `transaction_id_b`.
    pub user_id_b: String,
    pub date_delta: f64,
    pub is_plaid_transfer: bool,
}

/// How sure the engine is that a candidate is a transfer: a base, raised when
/// Plaid tagged either side as a transfer and when both land on one day.
pub fn score_confidence(is_plaid_transfer: bool, date_delta: f64) -> f64 {
    let mut confidence = BASE_CONFIDENCE;
    if is_plaid_transfer {
        confidence += PLAID_TRANSFER_BOOST;
    }
    if date_delta < 1.0 {
        confidence += SAME_DAY_BOOST;
    }
    confidence.min(0.99)
}

async fn fetch_users() -> anyhow::Result<Vec<String>> {
    let users = user::TABLE.query(Vec::new(), SearchFilters::default(), None).await?;
    Ok(users.iter().map(|row| str_of(row, "user_id").to_string()).collect())
}

/// Candidate pairs among the transactions of `user_ids` (a user and everyone
/// sharing data with them), so a transfer between two people's accounts is a
/// candidate like one between a single person's.
async fn fetch_candidates(user_ids: &[String], limit: i64, executor: &dyn Executor) -> anyhow::Result<Vec<DetectionCandidate>> {
    // Hidden-account exclusion: `account.hide=TRUE` marks an account as a
    // duplicate-data view of another (Plaid occasionally surfaces the same
    // product on two `account_id`s; the user hides the redundant one).
    // Transactions on hidden accounts mirror transactions on a visible
    // account, and the visible-side pairing is the real one. Including hidden
    // accounts as candidates makes duplicate-data transactions compete with
    // their visible twins, leaving labeled transactions on the hidden side
    // unpaired even when the engine would correctly pair the visible side.
    let result = executor
        .query(
            "SELECT
       t1.transaction_id AS transaction_id_a,
       t2.transaction_id AS transaction_id_b,
       t1.user_id AS user_id_a,
       t2.user_id AS user_id_b,
       ABS(t1.date - t2.date) AS date_delta,
       (
         (t1.raw->'personal_finance_category'->>'primary') LIKE 'TRANSFER%'
         OR (t2.raw->'personal_finance_category'->>'primary') LIKE 'TRANSFER%'
       ) AS is_plaid_transfer
     FROM transactions t1
     JOIN transactions t2
       ON t1.user_id = ANY($1::uuid[])
      AND t2.user_id = ANY($1::uuid[])
      -- Matched as plain comparisons on t2's columns so the planner can hash-join on
      -- amount; an expression over both sides forces a compare of every pair of rows.
      AND t2.amount = -t1.amount
      AND t1.amount <> 0
      AND t1.account_id <> t2.account_id
      AND t2.date BETWEEN t1.date - $2::int AND t1.date + $2::int
      AND t1.transaction_id < t2.transaction_id
     -- Scoped to each side's owner: a transaction's account_id can name another user's account.
     JOIN accounts a1 ON a1.account_id = t1.account_id AND a1.user_id = t1.user_id
     JOIN accounts a2 ON a2.account_id = t2.account_id AND a2.user_id = t2.user_id
     WHERE (t1.is_deleted IS NULL OR t1.is_deleted = FALSE)
       AND (t2.is_deleted IS NULL OR t2.is_deleted = FALSE)
       AND COALESCE(a1.hide, FALSE) = FALSE
       AND COALESCE(a2.hide, FALSE) = FALSE
       -- Block on suggested/confirmed pairings only. status='rejected'
       -- means the user said \"no\" to a specific pair, not \"this
       -- transaction can never be paired\", so the transactions stay
       -- eligible for OTHER counterparts.
       AND NOT EXISTS (
         SELECT 1 FROM transaction_pairs tp
         WHERE tp.user_id = ANY($1::uuid[])
           AND (tp.is_deleted IS NULL OR tp.is_deleted = FALSE)
           AND tp.status <> 'rejected'
           AND (
             tp.transaction_id_a IN (t1.transaction_id, t2.transaction_id)
             OR tp.transaction_id_b IN (t1.transaction_id, t2.transaction_id)
           )
       )
       -- Respect the user's explicit rejection of THIS specific pair:
       -- if (t1, t2) was rejected before, do not re-suggest it.
       AND NOT EXISTS (
         SELECT 1 FROM transaction_pairs tp
         WHERE tp.user_id = ANY($1::uuid[])
           AND (tp.is_deleted IS NULL OR tp.is_deleted = FALSE)
           AND tp.status = 'rejected'
           AND (
             (tp.transaction_id_a = t1.transaction_id AND tp.transaction_id_b = t2.transaction_id)
             OR (tp.transaction_id_a = t2.transaction_id AND tp.transaction_id_b = t1.transaction_id)
           )
       )
     ORDER BY ABS(t1.date - t2.date) ASC, t1.transaction_id ASC
     LIMIT $3",
            &[json!(user_ids), json!(DATE_WINDOW_DAYS), json!(limit)],
        )
        .await?;

    Ok(result
        .rows
        .iter()
        .map(|row: &Obj| DetectionCandidate {
            transaction_id_a: str_of(row, "transaction_id_a").to_string(),
            transaction_id_b: str_of(row, "transaction_id_b").to_string(),
            user_id_a: str_of(row, "user_id_a").to_string(),
            user_id_b: str_of(row, "user_id_b").to_string(),
            date_delta: number_of(row.get("date_delta")),
            is_plaid_transfer: row.get("is_plaid_transfer") == Some(&Json::Bool(true)),
        })
        .collect())
}

/// Suggests `candidate` as a pair. The pair belongs to the owner of its first
/// transaction in canonical order, as a pair made by hand does, so that when
/// sharing ends it stays with whoever holds that transaction. The candidate's
/// own order comes from the database's collation, which need not agree.
async fn create_pair(user_ids: &[String], candidate: &DetectionCandidate, executor: &dyn Executor) -> anyhow::Result<()> {
    let pair_id = uuid::Uuid::new_v4().to_string();
    let canonical = canonicalize_pair_ids(&candidate.transaction_id_a, &candidate.transaction_id_b);
    let owner_id = if canonical.transaction_id_a == candidate.transaction_id_a {
        &candidate.user_id_a
    } else {
        &candidate.user_id_b
    };
    // INSERT...SELECT WHERE NOT EXISTS instead of ON CONFLICT avoids requiring
    // a UNIQUE (transaction_id_a, transaction_id_b) constraint that the
    // auto-migration does not enforce. It is also stronger: it refuses any
    // insert that would reuse a transaction already in a non-deleted pair,
    // even with a different counterpart (the candidates query already filters
    // these out, but the IN clause closes the SELECT-then-INSERT race window).
    executor
        .query(
            "INSERT INTO transaction_pairs
       (pair_id, user_id, transaction_id_a, transaction_id_b, status)
     SELECT $1, $2, $3, $4, 'suggested'
     WHERE NOT EXISTS (
       SELECT 1 FROM transaction_pairs tp
       WHERE tp.user_id = ANY($5::uuid[])
         AND (tp.is_deleted IS NULL OR tp.is_deleted = FALSE)
         AND tp.status <> 'rejected'
         AND (
           tp.transaction_id_a IN ($3, $4)
           OR tp.transaction_id_b IN ($3, $4)
         )
     )
       AND NOT EXISTS (
         -- Mirror the UNIQUE(transaction_id_a, transaction_id_b)
         -- constraint: any existing row for this pair — including
         -- soft-deleted rejected tombstones — would 23505 the INSERT.
         -- Pre-filtering by the same shape skips the round-trip in
         -- both the common race (rejection lands between
         -- fetchCandidates and createPair) and the rarer
         -- soft-deleted-rejected case (catch-up cleanup tombstoned a
         -- rejected pair before a fresh transaction re-import). No
         -- is_deleted predicate — the UNIQUE constraint doesn't care
         -- about is_deleted, so neither does this guard.
         SELECT 1 FROM transaction_pairs tp
         WHERE tp.user_id = ANY($5::uuid[])
           AND (
             (tp.transaction_id_a = $3 AND tp.transaction_id_b = $4)
             OR (tp.transaction_id_a = $4 AND tp.transaction_id_b = $3)
           )
       )",
            &[
                json!(pair_id),
                json!(owner_id),
                json!(canonical.transaction_id_a),
                json!(canonical.transaction_id_b),
                json!(user_ids),
            ],
        )
        .await?;
    Ok(())
}

/// What one group's run did.
struct GroupRun {
    members: usize,
    suggested: i64,
}

/// One sharing group's run, anchored on `user_id`, inside the transaction the
/// caller opened on `client`. The group's members join `covered`.
async fn detect_for_group(client: &Client, user_id: &str, covered: &mut HashSet<String>) -> anyhow::Result<GroupRun> {
    lock_transfer_pairs(client, user_id).await?;
    let member_ids = get_sharing_user_ids(user_id, Some(client)).await?;
    covered.extend(member_ids.iter().cloned());

    // Pre-step: cascade soft-delete any existing pair whose own `is_deleted`
    // is FALSE but at least one of whose transactions has been soft-deleted
    // since the pair was created. Without this, the surviving counterpart
    // stays "stuck" paired with a ghost: the candidates' existing-pair filter
    // excludes it from re-detection forever. Going forward,
    // `delete_transactions` cascades to pairs at the source, so this catch-up
    // step handles already-stale rows.
    let stale_pair_cleanup = client
        .query(
            "UPDATE transaction_pairs tp
           SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
           WHERE tp.user_id = ANY($1::uuid[])
             AND (tp.is_deleted IS NULL OR tp.is_deleted = FALSE)
             AND EXISTS (
               SELECT 1 FROM transactions t
               WHERE t.transaction_id IN (tp.transaction_id_a, tp.transaction_id_b)
                 AND t.is_deleted = TRUE
             )",
            &[json!(member_ids)],
        )
        .await?;
    let cleaned = stale_pair_cleanup.row_count.unwrap_or(0);
    if cleaned > 0 {
        logger::info("Cleaned stale transfer pairs", Some(&ctx! { "userId": user_id, "count": cleaned }));
    }

    // Each member keeps the budget they had alone.
    let limit = PER_USER_CANDIDATE_LIMIT * member_ids.len() as i64;
    let candidates = fetch_candidates(&member_ids, limit, client).await?;
    if candidates.len() as i64 == limit {
        // The LIMIT just truncated the candidate set; the highest-`date_delta`
        // rows fell off the end. Surfaced so the cap can be tuned if
        // heavy-transfer users hit it routinely.
        logger::warn(
            "Transfer-detection candidate cap reached",
            Some(&ctx! { "userId": user_id, "members": member_ids.len(), "limit": limit }),
            None,
        );
    }
    let mut used_txn_ids: HashSet<&str> = HashSet::new();
    let mut suggested = 0;

    for candidate in &candidates {
        if used_txn_ids.contains(candidate.transaction_id_a.as_str())
            || used_txn_ids.contains(candidate.transaction_id_b.as_str())
        {
            continue;
        }

        let confidence = score_confidence(candidate.is_plaid_transfer, candidate.date_delta);
        if confidence < SUGGEST_THRESHOLD {
            continue;
        }

        // SAVEPOINT per pair: when a pair's insert fails (a UNIQUE violation
        // from a concurrent insert that slipped through, a transient database
        // error), roll back to the savepoint and carry on with the rest of the
        // candidates, rather than abort the group's whole transaction and lose
        // the pairs created earlier in the loop.
        client.query("SAVEPOINT pair_attempt", &[]).await?;
        match create_pair(&member_ids, candidate, client).await {
            Ok(()) => {
                client.query("RELEASE SAVEPOINT pair_attempt", &[]).await?;
                used_txn_ids.insert(&candidate.transaction_id_a);
                used_txn_ids.insert(&candidate.transaction_id_b);
                suggested += 1;
            }
            Err(error) => {
                client.query("ROLLBACK TO SAVEPOINT pair_attempt", &[]).await?;
                logger::error(
                    "Failed to insert transfer pair",
                    Some(&ctx! {
                        "userId": user_id,
                        "transaction_id_a": candidate.transaction_id_a,
                        "transaction_id_b": candidate.transaction_id_b,
                    }),
                    Some(&error),
                );
            }
        }
    }

    client.query("COMMIT", &[]).await?;

    if suggested > 0 {
        logger::info(
            "Suggested transfer pairs for user",
            Some(&ctx! {
                "userId": user_id,
                "members": member_ids.len(),
                "suggested": suggested,
                "candidatesConsidered": candidates.len(),
            }),
        );
    }
    Ok(GroupRun { members: member_ids.len(), suggested })
}

/// Background job that scans unpaired transactions and suggests transfer pairs.
///
/// Match criteria (enforced by the SQL):
///   - one user's transactions, or those of everyone in a sharing group;
///     different accounts
///   - equal absolute amount with opposite signs (debit/credit)
///   - |date_a - date_b| <= DATE_WINDOW_DAYS (currently 7)
///   - neither transaction already participates in a non-deleted pair
///
/// Confidence scoring (`score_confidence`):
///   - base 0.7
///   - +0.2 if Plaid tagged either transaction with personal_finance_category
///     primary = TRANSFER_IN/TRANSFER_OUT
///   - +0.1 if same calendar day (date_delta < 1)
///
/// Candidates with confidence >= 0.7 are inserted with status `suggested`.
///
/// Runs once per sharing group, anchored on its first member in the user
/// list, and once for each user who shares with nobody.
///
/// Concurrency: within one run, the first accepted pair for a transaction
/// removes that transaction from further pairing in this run, so one
/// transaction is never paired with several others when several candidates
/// fall in the date window.
///
/// Backfill semantics: the same code path handles incremental and historical
/// scans. The first run after deploy sees every previously-unpaired
/// transaction and emits pairs for it; later hourly runs are cheap because the
/// SQL filters out anything already in `transaction_pairs`.
pub async fn run_transfer_detection() -> anyhow::Result<()> {
    logger::info("Transfer-detection job started", None);

    let mut total_users = 0usize;
    let mut total_suggested = 0i64;

    match fetch_users().await {
        Ok(user_ids) => {
            // Everyone a finished run covered: the rest of a group needs no run of its own.
            let mut covered: HashSet<String> = HashSet::new();
            for user_id in &user_ids {
                if covered.contains(user_id) {
                    continue;
                }
                // One transaction per group, under the lock every transfer-pair
                // write in the group takes: it serializes against
                // `pair_transactions` / `confirm_transfer_pair` and against any
                // other concurrent run of this job (the scheduled run and a
                // manual sync firing back to back). Without it, both runs see
                // "A is free" through separate NOT EXISTS reads under READ
                // COMMITTED and both insert pairs involving A: a transaction in
                // two simultaneous active pairs.
                let client = match pool().connect().await {
                    Ok(client) => client,
                    Err(error) => {
                        logger::error("Transfer detection failed for user", Some(&ctx! { "userId": user_id }), Some(&error));
                        continue;
                    }
                };
                let run = async {
                    client.query("BEGIN", &[]).await?;
                    detect_for_group(&client, user_id, &mut covered).await
                }
                .await;
                match run {
                    Ok(run) => {
                        total_suggested += run.suggested;
                        total_users += run.members;
                    }
                    Err(error) => {
                        let _ = client.query("ROLLBACK", &[]).await;
                        logger::error("Transfer detection failed for user", Some(&ctx! { "userId": user_id }), Some(&error));
                    }
                }
            }
        }
        Err(error) => {
            logger::error("Transfer-detection job failed to fetch users", None, Some(&error));
        }
    }

    logger::info(
        "Transfer-detection job completed",
        Some(&ctx! { "usersProcessed": total_users, "pairsSuggested": total_suggested }),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // `detect-transfers.test.ts`, "scoreConfidence".
    #[test]
    fn base_confidence_for_a_same_window_non_plaid_match() {
        assert_eq!(score_confidence(false, 3.0), 0.7);
    }

    #[test]
    fn plaid_transfer_tag_adds_its_boost() {
        assert!((score_confidence(true, 3.0) - 0.9).abs() < 1e-9);
    }

    #[test]
    fn same_day_adds_its_boost() {
        assert!((score_confidence(false, 0.0) - 0.8).abs() < 1e-9);
    }

    #[test]
    fn boosts_stack_and_are_capped() {
        assert_eq!(score_confidence(true, 0.0), 0.99);
    }

    #[test]
    fn a_day_apart_is_not_the_same_day() {
        assert_eq!(score_confidence(false, 1.0), 0.7);
    }

    #[test]
    fn every_score_clears_the_threshold() {
        for (plaid, delta) in [(false, 7.0), (true, 7.0), (false, 0.0), (true, 0.0)] {
            assert!(score_confidence(plaid, delta) >= SUGGEST_THRESHOLD);
        }
    }
}
