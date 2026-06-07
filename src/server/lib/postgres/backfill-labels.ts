import { pool } from "./client";
import { logger } from "../logger";

/**
 * One-time backfill from `transactions.label_*` and `accounts.label_*` into
 * the `labels` table.
 *
 * Idempotent via `ON CONFLICT (parent_id, confidence) DO NOTHING` — re-running
 * after the first successful pass is a no-op. Runs on every startup as part
 * of `initializePostgres` until Stage 3 drops the legacy columns; at that
 * point this module becomes a no-op (the source columns don't exist) and the
 * call site can be removed.
 *
 * Translations:
 *
 * - **Transactions**: each row with any populated `label_*` field becomes one
 *   `labels` row. Confidence comes from `label_category_confidence` if
 *   present; otherwise defaults to `1.0` (the row carries a user-set
 *   budget/memo or a category with no engine-confidence — treated as
 *   user-confirmed). A row with `confidence = 0` represents a rejected
 *   suggestion and is carried through verbatim with the rejected
 *   `category_id` so the merchant signal can read it (PR #482's
 *   superseded approach lives here as data history).
 *
 * - **Accounts**: only `label_budget_id` exists today; backfilled with
 *   `confidence = 1.0` (user-set), no category/memo.
 */
export const backfillLabelsFromLegacyColumns = async (): Promise<void> => {
  // Skip cleanly if the legacy columns no longer exist (post-Stage 3 deploy).
  const colsExist = await pool.query<{ has_transactions: boolean; has_accounts: boolean }>(
    `
    SELECT
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'transactions' AND column_name = 'label_category_id'
      ) AS has_transactions,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'accounts' AND column_name = 'label_budget_id'
      ) AS has_accounts
    `,
  );
  const { has_transactions, has_accounts } = colsExist.rows[0];
  if (!has_transactions && !has_accounts) {
    logger.info("backfill-labels: legacy columns absent, nothing to do");
    return;
  }

  let transactionsInserted = 0;
  let accountsInserted = 0;

  if (has_transactions) {
    const txnResult = await pool.query(
      `
      INSERT INTO labels (parent_type, parent_id, user_id, budget_id, category_id, memo, confidence)
      SELECT
        'transaction',
        transaction_id,
        user_id,
        label_budget_id,
        label_category_id,
        label_memo,
        COALESCE(label_category_confidence, 1.0)
      FROM transactions
      WHERE (is_deleted IS NULL OR is_deleted = FALSE)
        AND (
          label_category_id IS NOT NULL
          OR label_budget_id IS NOT NULL
          OR label_memo IS NOT NULL
        )
      ON CONFLICT (parent_id, confidence) DO NOTHING
      `,
    );
    transactionsInserted = txnResult.rowCount ?? 0;
  }

  if (has_accounts) {
    const acctResult = await pool.query(
      `
      INSERT INTO labels (parent_type, parent_id, user_id, budget_id, confidence)
      SELECT
        'account',
        account_id,
        user_id,
        label_budget_id,
        1.0
      FROM accounts
      WHERE (is_deleted IS NULL OR is_deleted = FALSE)
        AND label_budget_id IS NOT NULL
      ON CONFLICT (parent_id, confidence) DO NOTHING
      `,
    );
    accountsInserted = acctResult.rowCount ?? 0;
  }

  if (transactionsInserted + accountsInserted > 0) {
    logger.info(
      `backfill-labels: inserted ${transactionsInserted} transaction labels + ${accountsInserted} account labels`,
    );
  }
};
