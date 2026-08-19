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
 * Engine-emitted suggestion the user hasn't acted on yet. Accepts every
 * row type the TransactionsPage renders (`filteredAndSorted` mixes the
 * three) — InvestmentTransaction carries the same `label.category_id` /
 * `label.category_confidence` columns and can be auto-suggested too.
 */
export const isSuggestedLabel = (
  e: Transaction | SplitTransaction | InvestmentTransaction,
): boolean => e.label.isSuggested();

/**
 * The "acceptable-suggestion" invariant that Accept-All must honor —
 * mirrors the `suggested` filter predicate (see `TypePredicates.suggested`
 * below) so button count and button action agree.
 *
 * Rules:
 *  - `label.isSuggested()` must be true (engine label, not user-acted).
 *  - A row that IS a half of a CONFIRMED transfer is "done" from the
 *    user's POV — the transfer state takes precedence over any lingering
 *    engine category label. `confirmTransferPair` doesn't rewrite the
 *    two halves' `category_confidence` columns, so a row can legitimately
 *    hold `label.isSuggested() === true` while its pair is confirmed;
 *    the Suggested view hides these, and Accept-All must not count them.
 *    (Without this guard the Transfers view — which shows both statuses
 *    for user audit — reports "Accept all N" against rows that were
 *    already accepted, and Accept-All fires a redundant no-op label
 *    mutation on each confirmed half.)
 *  - InvestmentTransaction has no transfer semantics; the transfer-guard
 *    doesn't apply and any suggested investment label is acceptable.
 */
export const isAcceptableSuggestion = (
  e: Transaction | SplitTransaction | InvestmentTransaction,
  ctx: FilterContext,
): boolean => {
  if (!isSuggestedLabel(e)) return false;
  if (e instanceof InvestmentTransaction) return true;
  return !isInConfirmedTransfer(e, ctx);
};

/**
 * Pick the subset of `data.transfers` whose pair has status `"suggested"` AND
 * at least one of its halves is present as a whole Transaction in
 * `visibleRows`. The visibility set is keyed by `transaction_id` so splits
 * (`.id === split_transaction_id`) and investment rows (no `transaction_id`)
 * can't produce a match — building it from `rows.map(r => r.id)` would
 * silently miss a pair whose only in-view row is a split of a half.
 *
 * Returns `[pair_id]` (deduped by `data.transfers`'s own uniqueness on
 * pair_id). The caller uses each pair_id as the argument to
 * `POST /api/transfers/pair` in the Accept-All fan-out.
 */
export const pickAcceptableTransferPairs = (
  visibleRows: readonly (Transaction | SplitTransaction | InvestmentTransaction)[],
  transfers: TransferDictionary,
): { pair_id: string }[] => {
  const visibleTxIds = new Set(
    visibleRows
      .filter((e): e is Transaction => e instanceof Transaction)
      .map((e) => e.transaction_id),
  );
  const pairs: { pair_id: string }[] = [];
  transfers.forEach((pair) => {
    if (pair.status !== "suggested") return;
    if (pair.transactions.some((t) => visibleTxIds.has(t.transaction_id))) {
      pairs.push({ pair_id: pair.pair_id });
    }
  });
  return pairs;
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
    !e.label.isConfirmed();
  suggested: Predicate = (e) =>
    !isInvestment(e) &&
    !isInConfirmedTransfer(e, this.context) &&
    (isSuggestedLabel(e) || isSuggestedTransferHalf(e, this.context));
  transfers: Predicate = (e) => !isInvestment(e) && isTransferHalf(e, this.context);
  /**
   * User-created row (cash or investment) — `source === "manual"`. Filed via
   * the manual-mint routes; distinguishes hand-entered rows from synced Plaid
   * history. Splits have no `source` field of their own, so a split of a
   * manual parent does NOT surface under this filter — matches the current UI
   * (manual mint doesn't create splits, and splitting a manual parent isn't
   * wired).
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
