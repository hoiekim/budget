import {
  pool,
  logger,
  usersTable,
  transactionsTable,
  splitTransactionsTable,
  IS_NOT_NULL,
} from "server";

interface MerchantSignal {
  label_category_id: string;
  // The category's parent section's parent budget. Carried alongside the
  // category so the suggestion writes `transactions.label_budget_id` too.
  // Without it the row's category select in the UI renders blank — the
  // dropdown's options are filtered by the row's `label_budget_id` (or
  // the account default), and a category whose actual parent budget is
  // neither of those is missing from the option list. The native
  // `<select>` then falls back to its empty placeholder, masking the
  // suggestion even though the dot is grey.
  label_budget_id: string;
  accepted: number;
  rejected: number;
}

interface UnlabeledTransaction {
  transaction_id: string;
  merchant_name: string;
}

// A split row doesn't store its own merchant_name — it inherits from its parent
// transaction via `split_transactions.transaction_id`. We join to the parent in
// `defaultFetchUnlabeledSplits` so the merchant-signal lookup uses the parent's
// merchant, matching how a user mentally categorizes splits.
interface UnlabeledSplit {
  split_transaction_id: string;
  merchant_name: string;
}

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
type LogFn = {
  info: (message: string, context?: Record<string, unknown>) => void;
  error: (message: string, context?: Record<string, unknown>, error?: unknown) => void;
};
type FetchUsersFn = () => Promise<string[]>;
type FetchUnlabeledFn = (userId: string) => Promise<UnlabeledTransaction[]>;
type FetchUnlabeledSplitsFn = (userId: string) => Promise<UnlabeledSplit[]>;
type ApplyLabelFn = (
  transactionId: string,
  userId: string,
  labelCategoryId: string,
  labelBudgetId: string,
  labelCategoryConfidence: number,
) => Promise<void>;
type ApplyLabelToSplitFn = (
  splitTransactionId: string,
  userId: string,
  labelCategoryId: string,
  labelBudgetId: string,
  labelCategoryConfidence: number,
) => Promise<void>;

// pg_trgm similarity threshold for grouping merchant_name variants
// (e.g., "STARBUCKS #1234" ~ "STARBUCKS COFFEE 9876"). 0.5 is a balanced
// default for short, dirty identifiers; tune per Plaid normalization quality.
const MERCHANT_SIMILARITY_THRESHOLD = 0.5;
const MERCHANT_SIGNAL_LIMIT = 30;

const defaultFetchUnlabeled: FetchUnlabeledFn = async (userId) => {
  const rows = await transactionsTable.query({
    user_id: userId,
    label_category_confidence: null,
    merchant_name: IS_NOT_NULL,
  });
  return rows
    .filter((r) => r.merchant_name != null)
    .map((r) => ({
      transaction_id: r.transaction_id as string,
      merchant_name: r.merchant_name as string,
    }));
};

const defaultApplyLabel: ApplyLabelFn = async (
  transactionId,
  userId,
  labelCategoryId,
  labelBudgetId,
  labelCategoryConfidence,
) => {
  await transactionsTable.update(
    transactionId,
    {
      label_category_id: labelCategoryId,
      label_budget_id: labelBudgetId,
      label_category_confidence: labelCategoryConfidence,
    },
    undefined,
    userId,
  );
};

// Splits have no merchant_name of their own — join to the parent transaction to
// borrow it. Filters: user-scoped, never-labeled, parent has a merchant_name,
// neither side soft-deleted. The custom JOIN can't be expressed via
// `splitTransactionsTable.query`, so this is a raw pool query with the same
// shape as `defaultFetchUnlabeled`. Closes #334.
const defaultFetchUnlabeledSplits: FetchUnlabeledSplitsFn = async (userId) => {
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
        AND (t.is_deleted IS NULL OR t.is_deleted = FALSE)`,
    [userId],
  );
  return result.rows.map((r) => ({
    split_transaction_id: r.split_transaction_id as string,
    merchant_name: r.merchant_name as string,
  }));
};

const defaultApplyLabelToSplit: ApplyLabelToSplitFn = async (
  splitTransactionId,
  userId,
  labelCategoryId,
  labelBudgetId,
  labelCategoryConfidence,
) => {
  await splitTransactionsTable.update(
    splitTransactionId,
    {
      label_category_id: labelCategoryId,
      label_budget_id: labelBudgetId,
      label_category_confidence: labelCategoryConfidence,
    },
    undefined,
    userId,
  );
};

/**
 * Runs auto-suggestion for transaction categories based on historical merchant patterns.
 *
 * Logic:
 * - For each user, find transactions with no category confidence (never labeled)
 * - For each such transaction's merchant_name, look at recent labeled transactions
 *   matching the merchant via pg_trgm fuzzy similarity
 * - If enough signal (>= 3 labeled, <= 10% reject rate, >= 95% confidence for best category),
 *   apply the suggestion with confidence = accepted / total_labeled (capped at 0.99)
 *
 * Direct SQL is reserved for the merchant-signal query, which uses pg_trgm
 * `similarity(...)` and a SUM(CASE WHEN ...) aggregation that the standard
 * Table helpers cannot express. The unlabeled fetch and the label-apply
 * use `transactionsTable.query` / `transactionsTable.update` (the standard pattern).
 */
export const runAutoSuggestions = async (
  queryFn: QueryFn = (sql, params) => pool.query(sql, params),
  log: LogFn = logger,
  fetchUsers: FetchUsersFn = async () => {
    const users = await usersTable.query({});
    return users.map((u) => u.user_id);
  },
  fetchUnlabeled: FetchUnlabeledFn = defaultFetchUnlabeled,
  applyLabel: ApplyLabelFn = defaultApplyLabel,
  fetchUnlabeledSplits: FetchUnlabeledSplitsFn = defaultFetchUnlabeledSplits,
  applyLabelToSplit: ApplyLabelToSplitFn = defaultApplyLabelToSplit,
): Promise<void> => {
  log.info("Auto-suggestion job started");

  let totalUsersProcessed = 0;
  let totalSuggested = 0;

  try {
    const userIds = await fetchUsers();

    for (const user_id of userIds) {
      try {
        const suggested = await processUserSuggestions(
          user_id,
          queryFn,
          log,
          fetchUnlabeled,
          applyLabel,
          fetchUnlabeledSplits,
          applyLabelToSplit,
        );
        totalSuggested += suggested;
        totalUsersProcessed++;
      } catch (error) {
        log.error("Auto-suggestion failed for user", { userId: user_id }, error);
      }
    }
  } catch (error) {
    log.error("Auto-suggestion job failed to fetch users", {}, error);
  }

  log.info("Auto-suggestion job completed", {
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
  // Cap at 0.99 — 1.0 is reserved for user-confirmed labels.
  return Math.min(confidence, 0.99);
};

const processUserSuggestions = async (
  userId: string,
  queryFn: QueryFn,
  log: LogFn,
  fetchUnlabeled: FetchUnlabeledFn,
  applyLabel: ApplyLabelFn,
  fetchUnlabeledSplits: FetchUnlabeledSplitsFn,
  applyLabelToSplit: ApplyLabelToSplitFn,
): Promise<number> => {
  // Cache signal per merchant across both passes — splits share their parent's
  // merchant_name, so a parent and its splits will hit the same cache entry.
  const merchantCache = new Map<string, MerchantSignal | null>();
  let suggested = 0;

  const lookupSignal = async (merchantName: string): Promise<MerchantSignal | null> => {
    let signal = merchantCache.get(merchantName);
    if (signal === undefined) {
      signal = await getMerchantSignal(userId, merchantName, queryFn);
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
    log.info("Auto-suggested categories for user", { userId, suggested });
  }

  return suggested;
};

const getMerchantSignal = async (
  userId: string,
  merchantName: string,
  queryFn: QueryFn,
): Promise<MerchantSignal | null> => {
  // Fuzzy-match merchant_name via pg_trgm similarity so that variants like
  // "STARBUCKS #1234" and "STARBUCKS COFFEE 9876" feed the same signal.
  // Inner SELECT picks the most-recent N transactions whose merchant_name is
  // similar enough, then we group by category and take the most-accepted one.
  // Stays raw SQL: similarity(...) + SUM(CASE WHEN ...) aggregation isn't
  // expressible via the standard Table.query helpers.
  // The outer query also joins categories → sections so the winning
  // category's actual parent budget is carried out alongside it. We need
  // that downstream when applying the label so the suggested row's
  // `label_budget_id` matches its `label_category_id` (otherwise the UI
  // select renders empty — see MerchantSignal docstring).
  const result = await queryFn(
    `SELECT
       recent.label_category_id,
       sections.budget_id AS label_budget_id,
       SUM(CASE WHEN recent.label_category_confidence = 1.0 THEN 1 ELSE 0 END) AS accepted,
       SUM(CASE WHEN recent.label_category_confidence = 0.0 THEN 1 ELSE 0 END) AS rejected
     FROM (
       SELECT label_category_id, label_category_confidence
       FROM transactions
       WHERE user_id = $1
         AND merchant_name IS NOT NULL
         AND similarity(merchant_name, $2) >= $3
         AND label_category_confidence IS NOT NULL
         AND (is_deleted IS NULL OR is_deleted = FALSE)
       ORDER BY similarity(merchant_name, $2) DESC, date DESC
       LIMIT $4
     ) recent
     JOIN categories ON categories.category_id = recent.label_category_id
     JOIN sections ON sections.section_id = categories.section_id
     GROUP BY recent.label_category_id, sections.budget_id
     ORDER BY accepted DESC
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
