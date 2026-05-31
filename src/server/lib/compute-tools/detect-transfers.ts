import { pool, logger, usersTable } from "server";
import { canonicalizePairIds } from "../postgres/models";

const BASE_CONFIDENCE = 0.7;
const PLAID_TRANSFER_BOOST = 0.2;
const SAME_DAY_BOOST = 0.1;
const SUGGEST_THRESHOLD = 0.7;
const DATE_WINDOW_DAYS = 3;
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
      AND ABS(t1.amount) = ABS(t2.amount)
      AND t1.amount * t2.amount < 0
      AND t1.account_id <> t2.account_id
      AND ABS(t1.date - t2.date) <= $2
      AND t1.transaction_id < t2.transaction_id
     WHERE (t1.is_deleted IS NULL OR t1.is_deleted = FALSE)
       AND (t2.is_deleted IS NULL OR t2.is_deleted = FALSE)
       AND NOT EXISTS (
         SELECT 1 FROM transaction_pairs tp
         WHERE tp.user_id = t1.user_id
           AND (tp.is_deleted IS NULL OR tp.is_deleted = FALSE)
           AND (
             tp.transaction_id_a IN (t1.transaction_id, t2.transaction_id)
             OR tp.transaction_id_b IN (t1.transaction_id, t2.transaction_id)
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
         AND (
           tp.transaction_id_a IN ($3, $4)
           OR tp.transaction_id_b IN ($3, $4)
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
 *   - |date_a - date_b| <= 3 days
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
        const candidates = await fetchCandidates(userId);
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
