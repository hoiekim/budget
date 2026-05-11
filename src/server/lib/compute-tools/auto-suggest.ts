import { pool, logger, usersTable, transactionsTable, IS_NOT_NULL } from "server";

interface MerchantSignal {
  label_category_id: string;
  accepted: number;
  rejected: number;
}

interface UnlabeledTransaction {
  transaction_id: string;
  merchant_name: string;
}

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
type LogFn = {
  info: (message: string, context?: Record<string, unknown>) => void;
  error: (message: string, context?: Record<string, unknown>, error?: unknown) => void;
};
type FetchUsersFn = () => Promise<string[]>;
type FetchUnlabeledFn = (userId: string) => Promise<UnlabeledTransaction[]>;
type ApplyLabelFn = (
  transactionId: string,
  userId: string,
  labelCategoryId: string,
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
  labelCategoryConfidence,
) => {
  await transactionsTable.update(
    transactionId,
    { label_category_id: labelCategoryId, label_category_confidence: labelCategoryConfidence },
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

const processUserSuggestions = async (
  userId: string,
  queryFn: QueryFn,
  log: LogFn,
  fetchUnlabeled: FetchUnlabeledFn,
  applyLabel: ApplyLabelFn,
): Promise<number> => {
  const unlabeled = await fetchUnlabeled(userId);
  if (unlabeled.length === 0) return 0;

  // Cache signal per merchant to avoid redundant queries
  const merchantCache = new Map<string, MerchantSignal | null>();
  let suggested = 0;

  for (const { transaction_id, merchant_name } of unlabeled) {
    let signal: MerchantSignal | null | undefined = merchantCache.get(merchant_name);

    if (signal === undefined) {
      signal = await getMerchantSignal(userId, merchant_name, queryFn);
      merchantCache.set(merchant_name, signal);
    }

    if (!signal) continue;

    const { label_category_id, accepted, rejected } = signal;
    const totalLabeled = accepted + rejected;

    if (totalLabeled < 3) continue;

    const rejectRate = rejected / totalLabeled;
    if (rejectRate > 0.1) continue;

    const confidence = accepted / totalLabeled;
    if (confidence < 0.95) continue;

    // Cap at 0.99 — 1.0 is reserved for user-confirmed labels
    const cappedConfidence = Math.min(confidence, 0.99);

    await applyLabel(transaction_id, userId, label_category_id, cappedConfidence);

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
  const result = await queryFn(
    `SELECT
       label_category_id,
       SUM(CASE WHEN label_category_confidence = 1.0 THEN 1 ELSE 0 END) AS accepted,
       SUM(CASE WHEN label_category_confidence = 0.0 THEN 1 ELSE 0 END) AS rejected
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
     GROUP BY label_category_id
     ORDER BY accepted DESC
     LIMIT 1`,
    [userId, merchantName, MERCHANT_SIMILARITY_THRESHOLD, MERCHANT_SIGNAL_LIMIT],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0] as { label_category_id: string; accepted: string; rejected: string };
  return {
    label_category_id: row.label_category_id,
    accepted: Number(row.accepted),
    rejected: Number(row.rejected),
  };
};
