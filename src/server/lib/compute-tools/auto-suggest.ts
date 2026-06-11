import {
  pool,
  logger,
  usersTable,
  transactionsTable,
  splitTransactionsTable,
  IS_NOT_NULL,
  AdditionalWhere,
} from "server";

// Compare-and-swap guard for both the transactions and split-transactions
// UPDATEs. The engine must only overwrite a row that is STILL unlabeled
// (`label_category_confidence IS NULL`) — never a row a user just confirmed
// (confidence = 1) between the fetch and the per-row apply. Lifted to a named
// exported constant so:
//   1. it's grep-able when reviewing changes to the suggestion path;
//   2. tests can assert both apply sites thread this exact reference, not
//      a silently-altered inline literal.
export const CAS_NULL_CONFIDENCE: AdditionalWhere = {
  column: "label_category_confidence",
  value: null,
};

// Highest confidence the auto-suggest engine may write. The confidence column
// has three reserved buckets, kept distinct so a row's suggestion provenance
// stays recoverable:
//   - `< 0.99`  → auto-suggest engine (this file)
//   - `= 0.99`  → /api/suggest-category (external Claude-instance writes)
//   - `= 1.0`   → user-confirmed labels (UI writes)
// The engine must cap strictly below 0.99: a merchant with 100% acceptance
// computes confidence = 1.0, and capping that at 0.99 would collide with the
// API bucket, making engine and API writes indistinguishable. Lifted to a
// named exported constant so the reservation map is grep-able and tests can
// assert the engine never emits 0.99. Closes #422.
export const AUTO_SUGGEST_MAX_CONFIDENCE = 0.98;

interface MerchantSignal {
  label_category_id: string;
  // The category's parent section's parent budget. Carried alongside the
  // category so the suggestion writes `transactions.label_budget_id` too.
  // Without it the row's category select in the UI renders blank — the
  // dropdown's options are filtered by the row's `label_budget_id` (or
  // the account default), and a category whose actual parent budget is
  // neither of those is missing from the option list. The native
  // `<select>` then falls back to its empty placeholder, masking the
  // suggestion even though the dot is yellow.
  label_budget_id: string;
  accepted: number;
  rejected: number;
}

interface UnlabeledTransaction {
  transaction_id: string;
  merchant_name: string;
}

// A split row doesn't store its own merchant_name — it inherits from its parent
// transaction via `split_transactions.transaction_id`. The split fetch joins to
// the parent so the merchant-signal lookup uses the parent's merchant, matching
// how a user mentally categorizes splits.
interface UnlabeledSplit {
  split_transaction_id: string;
  merchant_name: string;
}

// pg_trgm similarity threshold for grouping merchant_name variants
// (e.g., "STARBUCKS #1234" ~ "STARBUCKS COFFEE 9876"). 0.5 is a balanced
// default for short, dirty identifiers; tune per Plaid normalization quality.
const MERCHANT_SIMILARITY_THRESHOLD = 0.5;
const MERCHANT_SIGNAL_LIMIT = 30;

const fetchUnlabeled = async (userId: string): Promise<UnlabeledTransaction[]> => {
  const rows = await transactionsTable.query({
    user_id: userId,
    label_category_confidence: null,
    merchant_name: IS_NOT_NULL,
  });
  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  return rows
    .filter((r) => {
      return r.merchant_name != null && new Date(r.date) > oneWeekAgo;
    })
    .map((r) => ({
      transaction_id: r.transaction_id as string,
      merchant_name: r.merchant_name as string,
    }));
};

// Compare-and-swap: the UPDATE only matches rows that are STILL unlabeled
// (`label_category_confidence IS NULL`). Between the unlabeled fetch and
// this per-row call, a user may have confirmed the row in the UI (writing
// `confidence = 1`). Without the IS-NULL guard, the engine would overwrite
// that confirmation with its own 0.95-0.99 suggestion and replace the
// user's chosen `category_id` / `budget_id` with the engine's pick.
const applyLabel = async (
  transactionId: string,
  userId: string,
  labelCategoryId: string,
  labelBudgetId: string,
  labelCategoryConfidence: number,
): Promise<void> => {
  await transactionsTable.update(
    transactionId,
    {
      label_category_id: labelCategoryId,
      label_budget_id: labelBudgetId,
      label_category_confidence: labelCategoryConfidence,
    },
    undefined,
    userId,
    undefined,
    [CAS_NULL_CONFIDENCE],
  );
};

// Splits have no merchant_name of their own — join to the parent transaction to
// borrow it. Filters: user-scoped, never-labeled, parent has a merchant_name,
// neither side soft-deleted. The custom JOIN can't be expressed via
// `splitTransactionsTable.query`, so this is a raw pool query with the same
// shape as `fetchUnlabeled`. Closes #334.
const fetchUnlabeledSplits = async (userId: string): Promise<UnlabeledSplit[]> => {
  const result = await pool.query(
    `SELECT st.split_transaction_id, t.merchant_name
       FROM split_transactions st
       JOIN transactions t
         ON t.transaction_id = st.transaction_id
        AND t.user_id = st.user_id
      WHERE st.user_id = $1
        AND st.label_category_confidence IS NULL
        AND (st.is_deleted IS NULL OR st.is_deleted = FALSE)
        AND t.merchant_name IS NOT NULL
        AND (t.is_deleted IS NULL OR t.is_deleted = FALSE)
        AND t.date > NOW() - INTERVAL '1 week'`,
    [userId],
  );
  return result.rows.map((r) => ({
    split_transaction_id: r.split_transaction_id as string,
    merchant_name: r.merchant_name as string,
  }));
};

// Same CAS guard as `applyLabel` — the IS-NULL clause prevents the engine
// from clobbering a user-confirmed split that flipped from null → 1.0
// between the fetch and the per-row apply.
const applyLabelToSplit = async (
  splitTransactionId: string,
  userId: string,
  labelCategoryId: string,
  labelBudgetId: string,
  labelCategoryConfidence: number,
): Promise<void> => {
  await splitTransactionsTable.update(
    splitTransactionId,
    {
      label_category_id: labelCategoryId,
      label_budget_id: labelBudgetId,
      label_category_confidence: labelCategoryConfidence,
    },
    undefined,
    userId,
    undefined,
    [CAS_NULL_CONFIDENCE],
  );
};

/**
 * Runs auto-suggestion for transaction categories based on historical merchant patterns.
 *
 * Logic:
 * - For each user, find transactions with no category confidence (never labeled)
 * - For each such transaction's merchant_name, look at recent confirmed
 *   transactions matching the merchant via pg_trgm fuzzy similarity, AND
 *   count rejections of the winning category from `rejected_categories`
 * - If enough signal (>= 3 labeled, <= 10% reject rate, >= 95% confidence for best category),
 *   apply the suggestion with confidence = accepted / total_labeled (capped at 0.99)
 *
 * Direct SQL is reserved for the merchant-signal query, which uses pg_trgm
 * `similarity(...)` and a cross-table count (transactions + rejected_categories)
 * that the standard Table helpers cannot express. The unlabeled fetch and the
 * label-apply use `transactionsTable.query` / `transactionsTable.update` (the
 * standard pattern).
 */
export const runAutoSuggestions = async (): Promise<void> => {
  logger.info("Auto-suggestion job started");

  let totalUsersProcessed = 0;
  let totalSuggested = 0;

  try {
    const users = await usersTable.query({});
    const userIds = users.map((u) => u.user_id);

    for (const user_id of userIds) {
      try {
        const suggested = await processUserSuggestions(user_id);
        totalSuggested += suggested;
        totalUsersProcessed++;
      } catch (error) {
        logger.error("Auto-suggestion failed for user", { userId: user_id }, error);
      }
    }
  } catch (error) {
    logger.error("Auto-suggestion job failed to fetch users", {}, error);
  }

  logger.info("Auto-suggestion job completed", {
    usersProcessed: totalUsersProcessed,
    transactionsSuggested: totalSuggested,
  });
};

// Score a per-merchant signal against the gates. Returns the capped
// confidence to apply (in [0, 1)), or null if any gate fails.
const evaluateSignal = (signal: MerchantSignal): number | null => {
  const totalLabeled = signal.accepted + signal.rejected;
  if (totalLabeled < 3) return null;
  const rejectRate = signal.rejected / totalLabeled;
  if (rejectRate > 0.1) return null;
  const confidence = signal.accepted / totalLabeled;
  if (confidence < 0.95) return null;
  // Cap strictly below 0.99: 0.99 is reserved for /api/suggest-category and
  // 1.0 for user-confirmed labels. See AUTO_SUGGEST_MAX_CONFIDENCE.
  return Math.min(confidence, AUTO_SUGGEST_MAX_CONFIDENCE);
};

const processUserSuggestions = async (userId: string): Promise<number> => {
  // Cache signal per merchant across both passes — splits share their parent's
  // merchant_name, so a parent and its splits will hit the same cache entry.
  const merchantCache = new Map<string, MerchantSignal | null>();
  let suggested = 0;

  const lookupSignal = async (merchantName: string): Promise<MerchantSignal | null> => {
    let signal = merchantCache.get(merchantName);
    if (signal === undefined) {
      signal = await getMerchantSignal(userId, merchantName);
      merchantCache.set(merchantName, signal);
    }
    return signal;
  };

  // Pass 1: top-level transactions.
  const unlabeled = await fetchUnlabeled(userId);
  for (const { transaction_id, merchant_name } of unlabeled) {
    const signal = await lookupSignal(merchant_name);
    if (!signal) continue;
    const cappedConfidence = evaluateSignal(signal);
    if (cappedConfidence === null) continue;
    await applyLabel(
      transaction_id,
      userId,
      signal.label_category_id,
      signal.label_budget_id,
      cappedConfidence,
    );
    suggested++;
  }

  // Pass 2: split transactions. Shares `merchantCache` so a split whose parent
  // was just scored above doesn't re-hit the DB. Closes #334.
  const unlabeledSplits = await fetchUnlabeledSplits(userId);
  for (const { split_transaction_id, merchant_name } of unlabeledSplits) {
    const signal = await lookupSignal(merchant_name);
    if (!signal) continue;
    const cappedConfidence = evaluateSignal(signal);
    if (cappedConfidence === null) continue;
    await applyLabelToSplit(
      split_transaction_id,
      userId,
      signal.label_category_id,
      signal.label_budget_id,
      cappedConfidence,
    );
    suggested++;
  }

  if (suggested > 0) {
    logger.info("Auto-suggested categories for user", { userId, suggested });
  }

  return suggested;
};

const getMerchantSignal = async (
  userId: string,
  merchantName: string,
): Promise<MerchantSignal | null> => {
  // Two-source signal:
  //  - ACCEPTED: `transactions.label_category_confidence = 1.0` rows. The
  //    inner SELECT picks the top-N most-recent similar-merchant confirms,
  //    grouped by category, winner = max accepted.
  //  - REJECTED: `rejected_categories` rows joined to transactions for the
  //    merchant filter. Counts ALL rejections of the winning category for
  //    this user against this merchant — unbounded by the recency LIMIT
  //    above. Rationale: a rejection is an explicit user signal; it should
  //    stick until the user re-picks that category (which triggers
  //    `removeRejectedCategory`).
  //
  // Raw SQL stays because pg_trgm `similarity(...)` and the cross-table
  // count aren't expressible via standard Table.query helpers.
  //
  // The outer JOIN to categories → sections carries the winning category's
  // parent budget along — applied label needs both so the UI category
  // select renders against the right budget (see MerchantSignal docstring).
  const result = await pool.query(
    `WITH winning AS (
       SELECT label_category_id, COUNT(*) AS accepted
       FROM (
         SELECT label_category_id
         FROM transactions
         WHERE user_id = $1
           AND merchant_name IS NOT NULL
           AND similarity(merchant_name, $2) >= $3
           AND label_category_confidence = 1.0
           AND (is_deleted IS NULL OR is_deleted = FALSE)
         ORDER BY similarity(merchant_name, $2) DESC, date DESC
         LIMIT $4
       ) recent_confirms
       GROUP BY label_category_id
       ORDER BY COUNT(*) DESC
       LIMIT 1
     )
     SELECT
       w.label_category_id,
       sections.budget_id AS label_budget_id,
       w.accepted,
       (
         SELECT COUNT(*)
         FROM rejected_categories rc
         JOIN transactions t
           ON t.transaction_id = rc.transaction_id
           AND t.user_id = rc.user_id
         WHERE rc.user_id = $1
           AND rc.category_id = w.label_category_id
           AND t.merchant_name IS NOT NULL
           AND similarity(t.merchant_name, $2) >= $3
           AND (t.is_deleted IS NULL OR t.is_deleted = FALSE)
       ) AS rejected
     FROM winning w
     JOIN categories ON categories.category_id = w.label_category_id
     JOIN sections ON sections.section_id = categories.section_id
     LIMIT 1`,
    [userId, merchantName, MERCHANT_SIMILARITY_THRESHOLD, MERCHANT_SIGNAL_LIMIT],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0] as {
    label_category_id: string;
    label_budget_id: string;
    accepted: string;
    rejected: string;
  };
  return {
    label_category_id: row.label_category_id,
    label_budget_id: row.label_budget_id,
    accepted: Number(row.accepted),
    rejected: Number(row.rejected),
  };
};
