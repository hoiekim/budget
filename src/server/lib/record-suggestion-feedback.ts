import type { JSONTransactionLabel } from "common";
import {
  MaskedUser,
  upsertUserConfirmedSuggestion,
  upsertUserRejectedSuggestion,
} from "./postgres";

interface PreviousLabel {
  category_id: string | null;
  budget_id: string | null;
}

/**
 * Mirror a user's category action on a transaction into the `suggestions`
 * event log so the auto-suggest engine can learn from confirmations and
 * rejections (#333). The denormalized `transactions.label_*` columns stay
 * the read cache; this writes the append-only user-intent signal the engine
 * reads. Called at the route boundary (after a successful transaction
 * update) so every confirm/reject path — explicit category pick,
 * accept-in-place, and clear-to-reject — funnels through one choke point.
 *
 * Intent is read from `category_confidence` (set by `inferLabelConfidence`):
 *  - `1` → the user confirmed a category. The confirmed category is the one
 *    in the request body, or — for accept-in-place, where the body carries
 *    only `category_confidence` — the category already on the row.
 *  - `0` → the user rejected a category (cleared the select). The body's
 *    `category_id` is null, so the rejected category is the one that was on
 *    the row before the clear.
 *
 * Fractional confidence (engine writes) and absent confidence (no-op label
 * updates) never reach here — only the two explicit user actions feed the
 * signal.
 *
 * Stage 2a of #333: this records the signal. The read switch that makes
 * `getMerchantSignal` source confirm/reject counts from this table is a
 * follow-up.
 */
export const recordSuggestionFeedback = async (
  user: MaskedUser,
  transaction_id: string,
  label: Partial<JSONTransactionLabel> | undefined,
  previous: PreviousLabel,
): Promise<void> => {
  if (!label) return;
  const { category_confidence } = label;
  if (category_confidence !== 0 && category_confidence !== 1) return;

  // The body carries `category_id` only on an explicit pick; accept-in-place
  // and clear-to-reject omit it (or send null), so fall back to the category
  // that was on the row before this update.
  const bodyCategoryId =
    "category_id" in label ? label.category_id ?? null : null;
  const category_id = bodyCategoryId ?? previous.category_id;
  if (!category_id) return;

  if (category_confidence === 1) {
    await upsertUserConfirmedSuggestion(user, transaction_id, category_id);
    return;
  }

  // category_confidence === 0 — a rejection, UNLESS this request is a budget
  // switch that cleared the category as a side effect. Switching budgets is
  // not a category rejection and must not feed negative merchant signal. A
  // budget switch sends a `budget_id` that differs from the row's current
  // one; a genuine category clear leaves the budget unchanged (or only fills
  // an empty one with the account default). Err toward NOT recording a
  // false rejection: a budget change on an already-budgeted row is treated
  // as a switch, not a reject.
  const budgetSwitched =
    "budget_id" in label &&
    label.budget_id != null &&
    previous.budget_id != null &&
    label.budget_id !== previous.budget_id;
  if (budgetSwitched) return;

  await upsertUserRejectedSuggestion(user, transaction_id, category_id);
};
