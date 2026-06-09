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
  ENGINE_SCORED_AT,
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
 * Run manually on demand via `scripts/backfill-suggestions.ts` — it is NOT
 * wired into `initializePostgres`. Once every prod transaction is mirrored,
 * re-running it is a cheap no-op.
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
 * - **Confirmation mirrors the live `confidence === 1` invariant.** The app
 *   treats a legacy label as user-confirmed only when
 *   `label_category_confidence = 1` (explicit accept) or `IS NULL`
 *   (hand-set before the engine existed) — see
 *   `client/lib/hooks/calculation/budgets.ts` (`isConfirmed =
 *   category_confidence === 1 && !!category_id`), which classifies
 *   `category_id` set with `0 < confidence < 1` as "auto-suggested but
 *   unreviewed". So this backfill maps:
 *     - confidence `1` / `NULL` → user-confirmed: `is_confirmed = TRUE`,
 *       `confirmed_at = transactions.updated`, `engine_scored_at = NULL`.
 *     - `0 < confidence < 1` → unreviewed engine suggestion:
 *       `is_confirmed = FALSE`, `confirmed_at = NULL`,
 *       `engine_scored_at = transactions.updated`.
 *   This keeps `is_confirmed` a pure record of *user intent* (the schema's
 *   stated purpose) instead of stamping pending engine guesses as
 *   confirmations and inflating the merchant signal's confirm rate.
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
      WHERE table_schema = 'public'
        AND table_name = '${TRANSACTIONS}'
        AND column_name = '${LABEL_CATEGORY_ID}'
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
       ${IS_CONFIRMED}, ${CONFIRMED_AT}, ${ENGINE_SCORED_AT})
    SELECT
      ${TRANSACTION_ID},
      ${USER_ID},
      ${LABEL_CATEGORY_ID},
      COALESCE(${LABEL_CATEGORY_CONFIDENCE}, 1.0),
      (${LABEL_CATEGORY_CONFIDENCE} IS NULL OR ${LABEL_CATEGORY_CONFIDENCE} = 1.0),
      CASE WHEN ${LABEL_CATEGORY_CONFIDENCE} IS NULL OR ${LABEL_CATEGORY_CONFIDENCE} = 1.0
           THEN ${UPDATED} END,
      CASE WHEN ${LABEL_CATEGORY_CONFIDENCE} IS NULL OR ${LABEL_CATEGORY_CONFIDENCE} = 1.0
           THEN NULL ELSE ${UPDATED} END
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
