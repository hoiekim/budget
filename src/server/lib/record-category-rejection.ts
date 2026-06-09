import type { JSONTransactionLabel } from "common";
import type { MaskedUser } from "server";
import {
  addRejectedCategory,
  removeRejectedCategory,
  searchTransactionsById,
} from "server";

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
 *  - **Body sets `label.budget_id`** AND **`label.category_id: null`** →
 *    budget switch. The category nullification is a side effect of
 *    switching budget (categories belong to budgets), not an explicit
 *    rejection. **Skip the rejection write.** Disambiguation called out
 *    explicitly because the legacy confidence-only signal couldn't tell
 *    these apart (Hoie pushed back on the false-rejection case for the
 *    earlier #500 attempt).
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
  prevLabelCategoryId: string | null,
): Promise<void> => {
  if (!reqLabel || !("category_id" in reqLabel)) return;

  const newCategoryId = reqLabel.category_id;
  const isBudgetSwitch = "budget_id" in reqLabel && newCategoryId === null;

  if (isBudgetSwitch) {
    // Category nullification was a side effect of switching budget. Not
    // an explicit rejection — skip both the add and the remove.
    return;
  }

  if (newCategoryId === null) {
    // Genuine rejection. Record the *previous* category id (the one
    // being rejected). If the previous category was already null, there's
    // nothing concrete to reject.
    if (prevLabelCategoryId) {
      await addRejectedCategory(user, transaction_id, prevLabelCategoryId);
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
 * Read the current `label.category_id` for a transaction. Used by the
 * route layer to capture the previous label *before* the update so
 * `recordCategoryRejection` can name the category being rejected.
 *
 * Returns `null` if the transaction doesn't exist or the column is
 * null/undefined.
 */
export const getPrevLabelCategoryId = async (
  user: MaskedUser,
  transaction_id: string,
): Promise<string | null> => {
  const [tx] = await searchTransactionsById(user, [transaction_id]);
  return tx?.label?.category_id ?? null;
};
