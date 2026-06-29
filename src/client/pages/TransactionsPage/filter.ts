import {
  Transaction,
  SplitTransaction,
  InvestmentTransaction,
  TransferDictionary,
} from "client";
import type { TransactionsPageType } from "client/components";

/**
 * Per-row predicate context. Holds the cross-row state every predicate
 * needs to consult (today: the transfer dictionary) so the predicates
 * themselves stay one-liners.
 */
export interface FilterContext {
  transfers: TransferDictionary;
}

type LabeledRow = {
  label: { category_id?: string | null; category_confidence?: number | null };
};

/**
 * User has explicitly acted on this row's category — either confirmed
 * (confidence=1) or rejected (confidence=0). Per the JSONTransactionLabel
 * docstring, null = never labeled and 0<conf<1 = engine suggestion.
 */
const isUserLabelConfirmed = (e: LabeledRow): boolean => {
  const c_id = e.label.category_id;
  const c_conf = e.label.category_confidence;
  return !!(c_id && (c_conf === 1 || c_conf === 0));
};

/**
 * Engine-emitted suggestion the user hasn't acted on yet. Mirrors the
 * `isSuggestedLabel` helper that drives the Accept-All count — keep these
 * two in sync.
 */
export const isSuggestedLabel = (e: LabeledRow): boolean => {
  const c_id = e.label.category_id;
  const c_conf = e.label.category_confidence;
  return !!(c_id && c_conf && c_conf > 0 && c_conf < 1);
};

/**
 * Only whole Transactions participate in transfer pairs. A SplitTransaction
 * inherits its parent's transaction_id, so an unguarded lookup would resolve
 * the PARENT's pair and leak split rows into the Transfers view — same guard
 * the render path uses (TransactionsTable, TransactionRow).
 */
const isWholeTransaction = (
  e: Transaction | SplitTransaction,
): e is Transaction => e instanceof Transaction;

/**
 * Excluded from budget totals: any row — whole Transaction OR a
 * SplitTransaction of one — whose `transaction_id` belongs to a CONFIRMED
 * transfer pair. Splits inherit their parent's `transaction_id`, and
 * `getBudgetData` excludes both the parent and its splits from every budget
 * bucket via that same id (`calculation/budgets.ts:54,61`). So every
 * budget-semantic filter (deposits/expenses/unsorted/suggested + the
 * budget/section/category drill-down) must match — hence NO
 * `isWholeTransaction` guard here, unlike the transfer-pair *classification*
 * helpers below, which key on the row's own identity for rendering.
 */
export const isBudgetExcludedTransfer = (
  e: Transaction | SplitTransaction,
  ctx: FilterContext,
): boolean => ctx.transfers.byTransactionId.hasConfirmed(e.transaction_id);

const isSuggestedTransferHalf = (
  e: Transaction | SplitTransaction,
  ctx: FilterContext,
): boolean =>
  isWholeTransaction(e) && ctx.transfers.byTransactionId.hasSuggested(e.transaction_id);

const isTransferHalf = (
  e: Transaction | SplitTransaction,
  ctx: FilterContext,
): boolean =>
  isWholeTransaction(e) && ctx.transfers.byTransactionId.has(e.transaction_id);

type Predicate = (e: Transaction | SplitTransaction, ctx: FilterContext) => boolean;

/**
 * Per-type predicate map. Each predicate decides whether a row matches
 * the named type — pure, side-effect-free, and independently testable.
 * The OR-combinator at the call site (`types.some(t => PREDICATES[t](e,
 * ctx))`) gives the multi-choice semantics the UI promises.
 *
 *  - `deposits` / `expenses`: sign filters, but a confirmed-transfer row
 *    (whole or split) is excluded — it carries no budget meaning
 *    (`getBudgetData` skips it), so it must not surface under an
 *    income/expense view. Suggested transfers still count toward budget
 *    until confirmed, so they stay.
 *  - `unsorted`: "needs user action" — no user-confirmed category AND not
 *    part of a confirmed transfer. A confirmed transfer is "done" from the
 *    user's POV regardless of category state, and (matching getBudgetData)
 *    a split of one contributes to no budget, so it never "needs sorting".
 *  - `suggested`: a pending suggestion to review — either a suggested
 *    category label OR a suggested transfer-pair half. Confirmed transfers
 *    (and their splits) are excluded even if a category is still suggested
 *    (transfer state takes precedence).
 *  - `transfers`: any transfer-pair half (suggested or confirmed). Users
 *    auditing transfers want to see both states. This is the one
 *    render-classification predicate, so it keys on the row's own identity
 *    (`isTransferHalf` — whole transactions only; splits aren't pair halves).
 *
 * Adding a new type is one row + one test.
 */
const TYPE_PREDICATES: Record<TransactionsPageType, Predicate> = {
  deposits: (e, ctx) => !isBudgetExcludedTransfer(e, ctx) && e.amount < 0,
  expenses: (e, ctx) => !isBudgetExcludedTransfer(e, ctx) && e.amount > 0,
  unsorted: (e, ctx) => !isBudgetExcludedTransfer(e, ctx) && !isUserLabelConfirmed(e),
  suggested: (e, ctx) =>
    !isBudgetExcludedTransfer(e, ctx) && (isSuggestedLabel(e) || isSuggestedTransferHalf(e, ctx)),
  transfers: (e, ctx) => isTransferHalf(e, ctx),
};

/** True if `e` matches any of the selected types (empty list = match all). */
export const matchesAnySelectedType = (
  e: Transaction | SplitTransaction,
  types: TransactionsPageType[],
  ctx: FilterContext,
): boolean => {
  if (!types.length) return true;
  return types.some((t) => TYPE_PREDICATES[t](e, ctx));
};

/**
 * Investment transactions don't carry category labels and don't participate
 * in transfer pairs, so only the sign filters (deposits/expenses) are
 * meaningful. Other selected types are no-ops on the investment branch —
 * if the user has ONLY non-sign types selected, the investment branch
 * should still display rows (matches pre-PR behavior where the investment
 * filter only ever checked deposits/expenses).
 */
export const matchesAnySelectedInvestmentType = (
  e: InvestmentTransaction,
  types: TransactionsPageType[],
): boolean => {
  if (!types.length) return true;
  const signTypes = types.filter((t) => t === "deposits" || t === "expenses");
  if (!signTypes.length) return true;
  return signTypes.some((t) => (t === "deposits" ? e.amount < 0 : e.amount > 0));
};
