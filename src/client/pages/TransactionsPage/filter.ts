import {
  Transaction,
  SplitTransaction,
  InvestmentTransaction,
  TransferDictionary,
} from "client";
import type { TransactionsPageType } from "client/components";

/**
 * Per-row predicate context. Holds the cross-row state every predicate
 * needs to consult (today: the transfer dictionary). Initialized once on
 * `TypePredicates` construction so the per-row predicates themselves
 * stay one-liners and don't have to thread `ctx` through every call.
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
 * Row — whole Transaction OR a SplitTransaction of one — whose
 * `transaction_id` belongs to a CONFIRMED transfer pair. Splits inherit
 * their parent's `transaction_id`, and `getBudgetData` excludes both the
 * parent and its splits from every budget bucket via that same id
 * (`calculation/budgets.ts:54,61`). Every budget-semantic filter must
 * mirror — hence NO `isWholeTransaction` guard here. Named `isIn…` (not
 * `…Half`) because a split is a SIBLING of the pair half, not a half
 * itself; but the row is still "in" the transfer for budget-semantic
 * purposes.
 */
export const isInConfirmedTransfer = (
  e: Transaction | SplitTransaction,
  ctx: FilterContext,
): boolean => ctx.transfers.byTransactionId.hasConfirmed(e.transaction_id);

/**
 * Whole Transaction that IS a half of a SUGGESTED transfer pair.
 * Render-classification helper: splits inherit their parent's
 * `transaction_id`, so an unguarded lookup would resolve the PARENT's
 * pair and leak split rows — guarded on `isWholeTransaction`.
 */
const isSuggestedTransferHalf = (
  e: Transaction | SplitTransaction,
  ctx: FilterContext,
): boolean =>
  isWholeTransaction(e) && ctx.transfers.byTransactionId.hasSuggested(e.transaction_id);

/**
 * Whole Transaction that IS a half of any transfer pair (suggested or
 * confirmed). Render-classification helper used by the `transfers`
 * filter — splits aren't pair halves and must not slip in via their
 * inherited `transaction_id`.
 */
const isTransferHalf = (
  e: Transaction | SplitTransaction,
  ctx: FilterContext,
): boolean =>
  isWholeTransaction(e) && ctx.transfers.byTransactionId.has(e.transaction_id);

export type Predicate = (e: Transaction | SplitTransaction) => boolean;

/**
 * Per-type predicates for the TransactionsPage type-filter dropdown.
 *
 * The `FilterContext` (today: the transfer dictionary) is captured once
 * in the constructor and read off `this.context` by every predicate, so
 * the row-level predicates are one-liners and the call site is a
 * one-row toggle to add a new type.
 *
 *  - `deposits` / `expenses`: sign filters, but a confirmed-transfer row
 *    (whole or split) is excluded — `getBudgetData` skips it, so it
 *    carries no budget meaning and must not surface under an
 *    income/expense view. Suggested transfers still count toward budget
 *    totals until confirmed, so they stay.
 *  - `unsorted`: "needs user action" — no user-confirmed category AND not
 *    part of a confirmed transfer. A confirmed transfer is "done" from
 *    the user's POV regardless of category state.
 *  - `suggested`: a pending suggestion to review — either a suggested
 *    category label OR a suggested transfer-pair half. Confirmed transfers
 *    (and their splits) are excluded even if a category is still suggested
 *    (transfer state takes precedence).
 *  - `transfers`: any transfer-pair half (suggested or confirmed). Users
 *    auditing transfers want to see both states. The one
 *    render-classification predicate — keys on the row's own identity
 *    (`isTransferHalf`: whole transactions only; splits aren't pair
 *    halves).
 *
 * `any(types)` returns a predicate that ORs the named types together —
 * pass directly to `Array.prototype.filter`.
 */
export class TypePredicates {
  private context: FilterContext;

  constructor(context: FilterContext) {
    this.context = context;
  }

  deposits: Predicate = (e) => !isInConfirmedTransfer(e, this.context) && e.amount < 0;
  expenses: Predicate = (e) => !isInConfirmedTransfer(e, this.context) && e.amount > 0;
  unsorted: Predicate = (e) =>
    !isInConfirmedTransfer(e, this.context) && !isUserLabelConfirmed(e);
  suggested: Predicate = (e) =>
    !isInConfirmedTransfer(e, this.context) &&
    (isSuggestedLabel(e) || isSuggestedTransferHalf(e, this.context));
  transfers: Predicate = (e) => isTransferHalf(e, this.context);

  /**
   * Combine the named types with OR. Empty list = match everything (no
   * type filter active).
   */
  any =
    (types: TransactionsPageType[]): Predicate =>
    (e) => {
      if (!types.length) return true;
      return types.some((t) => this[t](e));
    };
}

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
