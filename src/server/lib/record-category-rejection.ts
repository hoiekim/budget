import type { JSONTransactionLabel } from "common";
import type { MaskedUser } from "server";
import {
  addRejectedCategory,
  removeRejectedCategory,
  searchTransactionsById,
} from "server";

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

const wasConfirmed = (prev: PrevLabel) => prev.category_confidence === 1;

/**
 * Mirror a `transactions.label` update into the `rejected_categories`
 * event log. Called from the `post-transaction` route layer AFTER the
 * legacy `transactions.label_*` columns have been updated.
 *
 * Decision matrix driven by the request body shape + the prev label's
 * suggested/confirmed state (`category_confidence`):
 *
 *  - **Body does not include `label.category_id`** → no category change;
 *    nothing to record. (Budget-only, memo-only, etc.)
 *
 *  - **Body clears category (`category_id: null`)**:
 *      - Budget changes simultaneously AND prev was *confirmed* (conf=1)
 *        → FE side effect of switching budget on a confirmed label.
 *        Skip the rejection write.
 *      - Otherwise (no budget change, OR prev was a *suggestion* the
 *        user just dropped) → genuine rejection of the previous
 *        category. UPSERT into `rejected_categories`.
 *
 *  - **Body sets `label.category_id: <string>`** (user picked or kept
 *    a category):
 *      - If the new category differs from a previously-*suggested*
 *        category → record rejection of the old suggested category.
 *        Hoie 2026-06-09: "If the new category is different from the
 *        suggested category, that's a rejection too."
 *      - Always: clear any prior rejection of the NEW category for
 *        this transaction (changed-my-mind path).
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

  // === Clearing the category ===
  if (newCategoryId === null) {
    const budgetChanged =
      "budget_id" in reqLabel && reqLabel.budget_id !== prevLabel.budget_id;

    // Budget switch on a CONFIRMED label is a FE side effect, not a
    // rejection. Budget switch on a SUGGESTED label IS a rejection —
    // the user is replacing the suggestion outright. Per Hoie's review:
    // "When the user switches budget while there was a suggested budget
    // & category already, the user is definitely rejecting the suggestion."
    if (budgetChanged && wasConfirmed(prevLabel)) return;

    if (prevCategoryId) {
      await addRejectedCategory(user, transaction_id, prevCategoryId);
    }
    return;
  }

  // === Picking or keeping a category ===
  if (typeof newCategoryId === "string") {
    // User picked a DIFFERENT category than the one that was previously
    // suggested → record a rejection of the suggestion.
    if (
      prevCategoryId &&
      newCategoryId !== prevCategoryId &&
      wasSuggested(prevLabel)
    ) {
      await addRejectedCategory(user, transaction_id, prevCategoryId);
    }

    // Clear any prior rejection of THIS category (changed-my-mind cycle).
    await removeRejectedCategory(user, transaction_id, newCategoryId);
  }
};

/**
 * Read the current `label.{category_id, budget_id, category_confidence}`
 * for a transaction. The route layer kicks this off in parallel with
 * the update so the rejection mirror can name the category being
 * cleared and tell a suggested label from a confirmed one.
 *
 * Returns null fields if the transaction doesn't exist or any column
 * is unset.
 */
export const getPrevLabel = async (
  user: MaskedUser,
  transaction_id: string,
): Promise<PrevLabel> => {
  const [tx] = await searchTransactionsById(user, [transaction_id]);
  return {
    category_id: tx?.label?.category_id ?? null,
    budget_id: tx?.label?.budget_id ?? null,
    category_confidence: tx?.label?.category_confidence ?? null,
  };
};
