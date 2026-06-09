import { pool } from "./client";
import { logger } from "../logger";
import {
  SUGGESTIONS,
  TRANSACTIONS,
  TRANSACTION_ID,
  USER_ID,
  CATEGORY_ID,
  CONFIDENCE,
  IS_CONFIRMED,
  CONFIRMED_AT,
  LABEL_CATEGORY_ID,
  LABEL_CATEGORY_CONFIDENCE,
  IS_DELETED,
  UPDATED,
} from "./models";

/**
 * One-time backfill from the legacy `transactions.label_*` denorm columns
 * into the new `suggestions` table.
 *
 * Idempotent via `ON CONFLICT (transaction_id, category_id) DO NOTHING`.
 * Runs on every startup as part of `initializePostgres`; once every prod
 * transaction is mirrored, this becomes a cheap no-op.
 *
 * Scope notes:
 *
 * - **Transactions only.** Accounts only carry `label_budget_id` (no
 *   category, no engine signal), so they don't need a suggestion row.
 *
 * - **Category required.** `category_id` is part of the composite PK and
 *   the whole point of the table — rows without a category carry no
 *   engine signal and are skipped. Budget-only / memo-only legacy rows
 *   stay reflected solely in `transactions.label_budget_id` /
 *   `label_memo`.
 *
 * - **Treated as user-confirmed.** Every legacy `transactions.label_*` row
 *   is a user-set label by definition — historically the engine wrote
 *   into the same column at fractional confidence, but those are
 *   transient suggestions, not durable engine state. We treat every
 *   migrated row as `is_confirmed = TRUE` with `confirmed_at =
 *   transactions.updated` so the merchant signal sees them as positive
 *   evidence with a real timestamp (recency filters can downweight stale
 *   confirmations).
 *
 * - **Confidence**: carried verbatim from `label_category_confidence` if
 *   present (so any explicit engine score in the legacy column survives),
 *   else defaults to `1.0`.
 */
export const backfillSuggestionsFromLegacyColumns = async (): Promise<void> => {
  // Skip cleanly if the legacy columns no longer exist (in case a future
  // refactor drops them — keeps this module safe to leave wired forever).
  const colsExist = await pool.query<{ has_transactions: boolean }>(
    `
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = '${TRANSACTIONS}' AND column_name = '${LABEL_CATEGORY_ID}'
    ) AS has_transactions
    `,
  );
  if (!colsExist.rows[0].has_transactions) {
    logger.info("backfill-suggestions: legacy column absent, nothing to do");
    return;
  }

  const result = await pool.query(
    `
    INSERT INTO ${SUGGESTIONS}
      (${TRANSACTION_ID}, ${USER_ID}, ${CATEGORY_ID}, ${CONFIDENCE},
       ${IS_CONFIRMED}, ${CONFIRMED_AT})
    SELECT
      ${TRANSACTION_ID},
      ${USER_ID},
      ${LABEL_CATEGORY_ID},
      COALESCE(${LABEL_CATEGORY_CONFIDENCE}, 1.0),
      TRUE,
      ${UPDATED}
    FROM ${TRANSACTIONS}
    WHERE (${IS_DELETED} IS NULL OR ${IS_DELETED} = FALSE)
      AND ${LABEL_CATEGORY_ID} IS NOT NULL
    ON CONFLICT (${TRANSACTION_ID}, ${CATEGORY_ID}) DO NOTHING
    `,
  );

  const inserted = result.rowCount ?? 0;
  if (inserted > 0) {
    logger.info(`backfill-suggestions: inserted ${inserted} suggestion rows`);
  }
};
