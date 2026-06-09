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
}

/**
 * Mirror a `transactions.label` update into the `rejected_categories`
 * event log. Called from the `post-transaction` route layer AFTER the
 * legacy `transactions.label_*` columns have been updated.
 *
 * The rule set, derived from how the FE expresses user intent (see
 * `client/components/TransactionsTable/TransactionRow.tsx`):
 *
 *  - **Body does not include `label.category_id`** → no category change;
 *    nothing to record. (A budget-only update, memo-only update, etc.)
 *
 *  - **Body sets `label.budget_id`** to a value *different from the
 *    previous* AND **`label.category_id: null`** → budget switch. The
 *    category nullification is a side effect of switching budget
 *    (categories belong to budgets), not an explicit rejection.
 *    **Skip the rejection write.** Disambiguation called out explicitly
 *    because the legacy confidence-only signal couldn't tell these
 *    apart (Hoie pushed back on the false-rejection case for the
 *    earlier #500 attempt). Note the "different from previous"
 *    requirement — a body that includes the unchanged budget_id is
 *    NOT a switch and the category clear remains a genuine rejection.
 *
 *  - **Body sets `label.category_id: null`** (without changing budget)
 *    AND the *previous* `label.category_id` was non-null → genuine
 *    rejection. UPSERT into `rejected_categories` with the previous
 *    category.
 *
 *  - **Body sets `label.category_id: <string>`** → user picked / kept a
 *    category. Clear any prior rejection of that category for this
 *    transaction ("changed my mind").
 *
 * Errors do NOT bubble — the legacy label update already succeeded; a
 * failure to mirror is a downgraded signal, not a route failure. Logged
 * for observability.
 */
export const recordCategoryRejection = async (
  user: MaskedUser,
  transaction_id: string,
  reqLabel: Partial<JSONTransactionLabel> | undefined,
  prevLabel: PrevLabel,
): Promise<void> => {
  if (!reqLabel || !("category_id" in reqLabel)) return;

  const newCategoryId = reqLabel.category_id;

  // Budget switch disambiguation: a body with `budget_id` set to a value
  // DIFFERENT from the previous budget AND `category_id: null` is a
  // budget change, not a category rejection. A body that includes the
  // unchanged budget_id falls through and the category clear is treated
  // as a genuine rejection.
  const isBudgetSwitch =
    "budget_id" in reqLabel &&
    newCategoryId === null &&
    reqLabel.budget_id !== prevLabel.budget_id;

  if (isBudgetSwitch) return;

  if (newCategoryId === null) {
    // Genuine rejection. Record the *previous* category id (the one
    // being rejected). If the previous category was already null, there's
    // nothing concrete to reject.
    if (prevLabel.category_id) {
      await addRejectedCategory(user, transaction_id, prevLabel.category_id);
    }
    return;
  }

  if (typeof newCategoryId === "string") {
    // User picked or kept a category — clear any prior rejection of THIS
    // category for THIS transaction. Cheap; no-op if no row matched.
    await removeRejectedCategory(user, transaction_id, newCategoryId);
  }
};

/**
 * Read the current `label.{category_id,budget_id}` for a transaction.
 * Used by the route layer to capture the previous label *before* the
 * update so `recordCategoryRejection` can:
 *  - name the category being rejected (when the request clears it), and
 *  - tell a real budget switch from a body that re-states the current
 *    budget_id alongside a category clear (false-positive guard).
 *
 * Returns `{category_id: null, budget_id: null}` if the transaction
 * doesn't exist or both columns are null/undefined.
 */
export const getPrevLabel = async (
  user: MaskedUser,
  transaction_id: string,
): Promise<PrevLabel> => {
  const [tx] = await searchTransactionsById(user, [transaction_id]);
  return {
    category_id: tx?.label?.category_id ?? null,
    budget_id: tx?.label?.budget_id ?? null,
  };
};
