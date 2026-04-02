import { pool, logger } from "server";

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

/**
 * Runs auto-suggestion for transaction categories based on historical merchant patterns.
 *
 * Logic:
 * - For each user, find transactions with no category confidence (never labeled)
 * - For each such transaction's merchant_name, look at recent labeled transactions
 * - If enough signal (>= 3 labeled, <= 10% reject rate, >= 95% confidence for best category),
 *   apply the suggestion with confidence = accepted / total_labeled (capped at 0.99)
 */
export const runAutoSuggestions = async (
  queryFn: QueryFn = (sql, params) => pool.query(sql, params),
  log: LogFn = logger
): Promise<void> => {
  log.info("Auto-suggestion job started");

  let totalUsersProcessed = 0;
  let totalSuggested = 0;

  try {
    const usersResult = await queryFn(
      "SELECT user_id FROM users WHERE (is_deleted IS NULL OR is_deleted = FALSE)"
    );
    const users = usersResult.rows as { user_id: string }[];

    for (const { user_id } of users) {
      try {
        const suggested = await processUserSuggestions(user_id, queryFn, log);
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
  log: LogFn
): Promise<number> => {
  // Get all unlabeled transactions with a merchant_name
  const unlabeledResult = await queryFn(
    `SELECT transaction_id, merchant_name
     FROM transactions
     WHERE user_id = $1
       AND label_category_confidence IS NULL
       AND merchant_name IS NOT NULL
       AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [userId]
  );

  const unlabeled = unlabeledResult.rows as unknown as UnlabeledTransaction[];
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

    await queryFn(
      `UPDATE transactions
       SET label_category_id = $1, label_category_confidence = $2, updated = CURRENT_TIMESTAMP
       WHERE transaction_id = $3 AND user_id = $4`,
      [label_category_id, cappedConfidence, transaction_id, userId]
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
  queryFn: QueryFn
): Promise<MerchantSignal | null> => {
  const result = await queryFn(
    `SELECT
       label_category_id,
       SUM(CASE WHEN label_category_confidence = 1.0 THEN 1 ELSE 0 END) AS accepted,
       SUM(CASE WHEN label_category_confidence = 0.0 THEN 1 ELSE 0 END) AS rejected
     FROM (
       SELECT label_category_id, label_category_confidence
       FROM transactions
       WHERE user_id = $1
         AND merchant_name = $2
         AND label_category_confidence IS NOT NULL
         AND (is_deleted IS NULL OR is_deleted = FALSE)
       ORDER BY date DESC
       LIMIT 30
     ) recent
     GROUP BY label_category_id
     ORDER BY accepted DESC
     LIMIT 1`,
    [userId, merchantName]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0] as { label_category_id: string; accepted: string; rejected: string };
  return {
    label_category_id: row.label_category_id,
    accepted: Number(row.accepted),
    rejected: Number(row.rejected),
  };
};
