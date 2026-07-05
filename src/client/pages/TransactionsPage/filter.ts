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

/**
 * User has explicitly acted on this row's category — either confirmed
 * (confidence=1) or rejected (confidence=0). Per the JSONTransactionLabel
 * docstring, null = never labeled and 0<conf<1 = engine suggestion.
 */
const isUserLabelConfirmed = (e: Transaction | SplitTransaction): boolean => {
  const c_id = e.label.category_id;
  const c_conf = e.label.category_confidence;
  return !!(c_id && (c_conf === 1 || c_conf === 0));
};

/**
 * Engine-emitted suggestion the user hasn't acted on yet. Accepts every
 * row type the TransactionsPage renders (`filteredAndSorted` mixes the
 * three) — InvestmentTransaction carries the same `label.category_id` /
 * `label.category_confidence` columns and can be auto-suggested too.
 */
export const isSuggestedLabel = (
  e: Transaction | SplitTransaction | InvestmentTransaction,
): boolean => {
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

type AnyRow = Transaction | SplitTransaction | InvestmentTransaction;

export type Predicate = (e: AnyRow) => boolean;

const isInvestment = (e: AnyRow): e is InvestmentTransaction =>
  e instanceof InvestmentTransaction;

/**
 * Per-type predicates for the TransactionsPage type-filter dropdown.
 *
 * The `FilterContext` (today: the transfer dictionary) is captured once
 * in the constructor and read off `this.context` by every predicate, so
 * the row-level predicates are one-liners and the call site is a
 * one-row toggle to add a new type.
 *
 *  - `deposits` / `expenses`: sign filters. For Transaction / SplitTransaction
 *    a confirmed-transfer row (whole or split) is excluded — `getBudgetData`
 *    skips it, so it carries no budget meaning and must not surface under an
 *    income/expense view. InvestmentTransaction has no transfer semantics so
 *    it's a pure sign check. Suggested transfers still count toward budget
 *    totals until confirmed, so they stay.
 *  - `unsorted`: "needs user action" — no user-confirmed category AND not
 *    part of a confirmed transfer. A confirmed transfer is "done" from
 *    the user's POV regardless of category state. Not applicable to
 *    InvestmentTransaction (no category labels).
 *  - `suggested`: a pending suggestion to review — either a suggested
 *    category label OR a suggested transfer-pair half. Confirmed transfers
 *    (and their splits) are excluded even if a category is still suggested
 *    (transfer state takes precedence). Not applicable to
 *    InvestmentTransaction.
 *  - `transfers`: any transfer-pair half (suggested or confirmed). Users
 *    auditing transfers want to see both states. The one
 *    render-classification predicate — keys on the row's own identity
 *    (`isTransferHalf`: whole transactions only; splits aren't pair
 *    halves). Not applicable to InvestmentTransaction.
 *
 * `any(types)` returns a predicate that ORs the named types together —
 * pass directly to `Array.prototype.filter`.
 */
export class TypePredicates {
  private context: FilterContext;

  constructor(context: FilterContext) {
    this.context = context;
  }

  deposits: Predicate = (e) =>
    isInvestment(e)
      ? e.amount < 0
      : !isInConfirmedTransfer(e, this.context) && e.amount < 0;
  expenses: Predicate = (e) =>
    isInvestment(e)
      ? e.amount > 0
      : !isInConfirmedTransfer(e, this.context) && e.amount > 0;
  unsorted: Predicate = (e) =>
    !isInvestment(e) &&
    !isInConfirmedTransfer(e, this.context) &&
    !isUserLabelConfirmed(e);
  suggested: Predicate = (e) =>
    !isInvestment(e) &&
    !isInConfirmedTransfer(e, this.context) &&
    (isSuggestedLabel(e) || isSuggestedTransferHalf(e, this.context));
  transfers: Predicate = (e) => !isInvestment(e) && isTransferHalf(e, this.context);
  /**
   * User-created row (cash or investment) — `source === "manual"`. Filed
   * via #567/#585's mint routes; distinguishes hand-entered rows from
   * synced Plaid history. Splits don't carry their own `source` and are
   * treated as inheriting from their parent transaction — but the
   * SplitTransaction row itself has no `source` field, so a split of a
   * manual parent does NOT surface under this filter today. That matches
   * how the current UI works: manual mint doesn't create splits, and
   * splitting a manual parent isn't wired.
   */
  manual: Predicate = (e) =>
    !(e instanceof SplitTransaction) && (e as { source?: string }).source === "manual";

  /** Combine the named types with OR. Empty list = match everything. */
  any =
    (types: TransactionsPageType[]): Predicate =>
    (e) => {
      if (!types.length) return true;
      return types.some((t) => this[t](e));
    };
}
