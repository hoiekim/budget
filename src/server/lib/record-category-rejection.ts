import type { JSONTransactionLabel } from "common";
import type { MaskedUser } from "server";
import { addRejectedCategory, removeRejectedCategory, pool } from "server";

export interface PrevLabel {
  category_id: string | null;
  budget_id: string | null;
  /** `transactions.label_category_confidence`. Drives the suggested-vs-confirmed
   *  distinction the disambiguation logic needs to tell a genuine rejection
   *  from a FE side effect. `1` = user-confirmed; `(0, 1)` = engine-suggested;
   *  `null`/`0`/undefined = no label / cleared. */
  category_confidence: number | null;
}

const wasSuggested = (prev: PrevLabel) =>
  prev.category_confidence !== null &&
  prev.category_confidence > 0 &&
  prev.category_confidence < 1;

/**
 * Mirror a `transactions.label` update into the `rejected_categories`
 * event log. Called from the `post-transaction` route layer AFTER the
 * legacy `transactions.label_*` columns have been updated.
 *
 * Rules:
 *  - **Body does not include `label.category_id`** → no category change;
 *    nothing to record. (Budget-only, memo-only, etc.)
 *  - **Prev was a SUGGESTION** (`0 < category_confidence < 1`) AND the
 *    new category differs from prev → record rejection of the previous
 *    category. Clearing or replacing a *confirmed* label is not a
 *    rejection — the user is re-categorizing, not signaling the prior
 *    choice was wrong.
 *  - **New category is a string** (not null) → clear any prior rejection
 *    of THAT category (changed-my-mind cycle).
 *
 * Errors do NOT bubble — the legacy label update already succeeded; a
 * failure to mirror is a downgraded signal, not a route failure.
 */
export const recordCategoryRejection = async (
  user: MaskedUser,
  transaction_id: string,
  reqLabel: Partial<JSONTransactionLabel> | undefined,
  prevLabel: PrevLabel,
): Promise<void> => {
  if (!reqLabel || !("category_id" in reqLabel)) return;

  const newCategoryId = reqLabel.category_id;
  const prevCategoryId = prevLabel.category_id;

  if (
    prevCategoryId &&
    newCategoryId !== prevCategoryId &&
    wasSuggested(prevLabel)
  ) {
    await addRejectedCategory(user, transaction_id, prevCategoryId);
  }

  if (typeof newCategoryId === "string") {
    await removeRejectedCategory(user, transaction_id, newCategoryId);
  }
};

/**
 * Read the current `label.{category_id, budget_id, category_confidence}`
 * for a transaction. The route layer awaits this serially *before* the
 * primary update — running the read in parallel races against the
 * overwrite and the mirror could see post-update state. The mirror's
 * downstream UPSERT is the part that runs off the latency path; the
 * "before" read isn't.
 *
 * Returns null fields if the transaction doesn't exist or any column
 * is unset.
 */
export const getPrevLabel = async (
  user: MaskedUser,
  transaction_id: string,
): Promise<PrevLabel> => {
  // Targeted SELECT instead of routing through `searchTransactionsById`
  // (which does SELECT *). This runs on the hot POST /transaction path —
  // pulling every column just to read three values is wasteful even on a
  // table with no heavy fields. user_id scopes the row so a request
  // referencing another user's transaction_id reads as "no row found"
  // (returning null fields) instead of leaking the prev label.
  const result = await pool.query<{
    label_category_id: string | null;
    label_budget_id: string | null;
    label_category_confidence: number | null;
  }>(
    `SELECT label_category_id, label_budget_id, label_category_confidence
     FROM transactions
     WHERE transaction_id = $1 AND user_id = $2
       AND (is_deleted IS NULL OR is_deleted = FALSE)
     LIMIT 1`,
    [transaction_id, user.user_id],
  );
  const row = result.rows[0];
  return {
    category_id: row?.label_category_id ?? null,
    budget_id: row?.label_budget_id ?? null,
    category_confidence: row?.label_category_confidence ?? null,
  };
};
