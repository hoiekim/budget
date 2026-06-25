import { TRANSFER_DATE_WINDOW_DAYS } from "common";
import { pool, logger, usersTable } from "server";
import { canonicalizePairIds } from "../postgres/models";

const BASE_CONFIDENCE = 0.7;
const PLAID_TRANSFER_BOOST = 0.2;
const SAME_DAY_BOOST = 0.1;
const SUGGEST_THRESHOLD = 0.7;
// Re-exported under the local name kept in the SQL comments + JSDoc.
const DATE_WINDOW_DAYS = TRANSFER_DATE_WINDOW_DAYS;
const PER_USER_CANDIDATE_LIMIT = 500;

export interface DetectionCandidate {
  transaction_id_a: string;
  transaction_id_b: string;
  date_delta: number;
  is_plaid_transfer: boolean;
}

export const scoreConfidence = (
  isPlaidTransfer: boolean,
  dateDelta: number,
): number => {
  let confidence = BASE_CONFIDENCE;
  if (isPlaidTransfer) confidence += PLAID_TRANSFER_BOOST;
  if (dateDelta < 1) confidence += SAME_DAY_BOOST;
  return Math.min(confidence, 0.99);
};

const fetchUsers = async (): Promise<string[]> => {
  const users = await usersTable.query({});
  return users.map((u) => u.user_id);
};

const fetchCandidates = async (userId: string): Promise<DetectionCandidate[]> => {
  // Hidden-account exclusion: `account.hide=TRUE` marks an account as
  // duplicate-data view of another (Plaid occasionally surfaces the
  // same product on two `account_id`s; the user hides the redundant
  // one). Transactions on hidden accounts are mirrors of transactions
  // on a visible account — the visible-side pairing is the real one.
  // Including hidden accounts as candidates makes duplicate-data
  // transactions compete with their visible twins, leaving labeled
  // transactions on the hidden side unpaired even when the engine
  // would correctly pair the visible side.
  const result = await pool.query(
    `SELECT
       t1.transaction_id AS transaction_id_a,
       t2.transaction_id AS transaction_id_b,
       ABS(t1.date - t2.date) AS date_delta,
       (
         (t1.raw->'personal_finance_category'->>'primary') LIKE 'TRANSFER%'
         OR (t2.raw->'personal_finance_category'->>'primary') LIKE 'TRANSFER%'
       ) AS is_plaid_transfer
     FROM transactions t1
     JOIN transactions t2
       ON t1.user_id = t2.user_id
      AND t1.user_id = $1
      AND t1.amount + t2.amount = 0
      AND t1.amount <> 0
      AND t1.account_id <> t2.account_id
      AND ABS(t1.date - t2.date) <= $2
      AND t1.transaction_id < t2.transaction_id
     JOIN accounts a1 ON a1.account_id = t1.account_id
     JOIN accounts a2 ON a2.account_id = t2.account_id
     WHERE (t1.is_deleted IS NULL OR t1.is_deleted = FALSE)
       AND (t2.is_deleted IS NULL OR t2.is_deleted = FALSE)
       AND COALESCE(a1.hide, FALSE) = FALSE
       AND COALESCE(a2.hide, FALSE) = FALSE
       -- Block on suggested/confirmed pairings only. status='rejected'
       -- means the user said "no" to a specific pair, not "this
       -- transaction can never be paired", so the transactions stay
       -- eligible for OTHER counterparts.
       AND NOT EXISTS (
         SELECT 1 FROM transaction_pairs tp
         WHERE tp.user_id = t1.user_id
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
         WHERE tp.user_id = t1.user_id
           AND (tp.is_deleted IS NULL OR tp.is_deleted = FALSE)
           AND tp.status = 'rejected'
           AND (
             (tp.transaction_id_a = t1.transaction_id AND tp.transaction_id_b = t2.transaction_id)
             OR (tp.transaction_id_a = t2.transaction_id AND tp.transaction_id_b = t1.transaction_id)
           )
       )
     ORDER BY ABS(t1.date - t2.date) ASC, t1.transaction_id ASC
     LIMIT $3`,
    [userId, DATE_WINDOW_DAYS, PER_USER_CANDIDATE_LIMIT],
  );

  return result.rows.map((row) => ({
    transaction_id_a: row.transaction_id_a as string,
    transaction_id_b: row.transaction_id_b as string,
    date_delta: Number(row.date_delta),
    is_plaid_transfer: row.is_plaid_transfer === true,
  }));
};

const createPair = async (
  userId: string,
  transactionIdA: string,
  transactionIdB: string,
): Promise<void> => {
  const pair_id = crypto.randomUUID();
  const canonical = canonicalizePairIds(transactionIdA, transactionIdB);
  // INSERT...SELECT WHERE NOT EXISTS instead of ON CONFLICT to avoid
  // requiring a UNIQUE (transaction_id_a, transaction_id_b) constraint
  // that isn't enforced by the auto-migration. Also stronger: this rejects
  // any insert that would re-use a transaction already in a non-deleted
  // pair, even with a different counterpart (the candidates query already
  // filters these out, but the IN clause closes the SELECT-then-INSERT
  // race window).
  await pool.query(
    `INSERT INTO transaction_pairs
       (pair_id, user_id, transaction_id_a, transaction_id_b, status)
     SELECT $1, $2, $3, $4, 'suggested'
     WHERE NOT EXISTS (
       SELECT 1 FROM transaction_pairs tp
       WHERE tp.user_id = $2
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
         WHERE tp.user_id = $2
           AND (
             (tp.transaction_id_a = $3 AND tp.transaction_id_b = $4)
             OR (tp.transaction_id_a = $4 AND tp.transaction_id_b = $3)
           )
       )`,
    [
      pair_id,
      userId,
      canonical.transaction_id_a,
      canonical.transaction_id_b,
    ],
  );
};

/**
 * Background job that scans unpaired transactions and suggests transfer pairs.
 *
 * Match criteria (enforced by the SQL):
 *   - same user, different accounts
 *   - equal absolute amount with opposite signs (debit/credit)
 *   - |date_a - date_b| <= DATE_WINDOW_DAYS (currently 7)
 *   - neither transaction already participates in a non-deleted pair
 *
 * Confidence scoring (`scoreConfidence`):
 *   - base 0.7
 *   - +0.2 if Plaid tagged either transaction with personal_finance_category
 *     primary = TRANSFER_IN/TRANSFER_OUT
 *   - +0.1 if same calendar day (date_delta < 1)
 *
 * Candidates with confidence >= 0.7 are inserted with status `suggested`.
 *
 * Concurrency: within one run, the first accepted pair for a transaction
 * removes that transaction from further pairing in this run, preventing one
 * transaction from being paired with multiple others if several candidates
 * fall in the date window.
 *
 * Backfill semantics: the same code path handles incremental and historical
 * scans. The first run after deploy sees every previously-unpaired transaction
 * and emits pairs for it; subsequent hourly runs are cheap because the SQL
 * filters out anything already in `transaction_pairs`.
 */
export const runTransferDetection = async (): Promise<void> => {
  logger.info("Transfer-detection job started");

  let totalUsers = 0;
  let totalSuggested = 0;

  try {
    const userIds = await fetchUsers();
    for (const userId of userIds) {
      try {
        // Pre-step: cascade soft-delete any existing pair whose own
        // `is_deleted` is FALSE but at least one of its referenced
        // transactions has been soft-deleted since the pair was
        // created. Without this, the surviving counterpart stays
        // "stuck" paired with a ghost — fetchCandidates' existing-pair
        // filter excludes it from re-detection forever. Going forward,
        // `deleteTransactions` cascades to pairs at the source, so
        // this catch-up step handles already-stale rows.
        const stalePairCleanup = await pool.query(
          `UPDATE transaction_pairs tp
           SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
           WHERE tp.user_id = $1
             AND (tp.is_deleted IS NULL OR tp.is_deleted = FALSE)
             AND EXISTS (
               SELECT 1 FROM transactions t
               WHERE t.transaction_id IN (tp.transaction_id_a, tp.transaction_id_b)
                 AND t.is_deleted = TRUE
             )`,
          [userId],
        );
        if ((stalePairCleanup.rowCount ?? 0) > 0) {
          logger.info("Cleaned stale transfer pairs", {
            userId,
            count: stalePairCleanup.rowCount,
          });
        }

        const candidates = await fetchCandidates(userId);
        if (candidates.length === PER_USER_CANDIDATE_LIMIT) {
          // The LIMIT just truncated the candidate set; the highest-
          // `date_delta` rows fell off the end. Surface so the cap can
          // be tuned if heavy-transfer users hit it routinely.
          logger.warn("Transfer-detection candidate cap reached", {
            userId,
            limit: PER_USER_CANDIDATE_LIMIT,
          });
        }
        const usedTxnIds = new Set<string>();
        let userSuggested = 0;

        for (const candidate of candidates) {
          if (
            usedTxnIds.has(candidate.transaction_id_a) ||
            usedTxnIds.has(candidate.transaction_id_b)
          ) {
            continue;
          }

          const confidence = scoreConfidence(
            candidate.is_plaid_transfer,
            candidate.date_delta,
          );
          if (confidence < SUGGEST_THRESHOLD) continue;

          try {
            await createPair(
              userId,
              candidate.transaction_id_a,
              candidate.transaction_id_b,
            );
            usedTxnIds.add(candidate.transaction_id_a);
            usedTxnIds.add(candidate.transaction_id_b);
            userSuggested++;
          } catch (err) {
            logger.error(
              "Failed to insert transfer pair",
              {
                userId,
                transaction_id_a: candidate.transaction_id_a,
                transaction_id_b: candidate.transaction_id_b,
              },
              err,
            );
          }
        }

        totalSuggested += userSuggested;
        totalUsers++;
        if (userSuggested > 0) {
          logger.info("Suggested transfer pairs for user", {
            userId,
            suggested: userSuggested,
            candidatesConsidered: candidates.length,
          });
        }
      } catch (err) {
        logger.error("Transfer detection failed for user", { userId }, err);
      }
    }
  } catch (err) {
    logger.error("Transfer-detection job failed to fetch users", {}, err);
  }

  logger.info("Transfer-detection job completed", {
    usersProcessed: totalUsers,
    pairsSuggested: totalSuggested,
  });
};
