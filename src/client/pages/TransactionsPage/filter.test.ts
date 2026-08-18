// Run with: bun test --preload ./scripts/test-preload.ts filter.test.ts
import { describe, test, expect } from "bun:test";
import { InvestmentTransactionType, InvestmentTransactionSubtype } from "plaid";

import {
  isAcceptableSuggestion,
  isSuggestedLabel,
  pickAcceptableTransferPairs,
  TypePredicates,
  type FilterContext,
} from "./filter";
import type { TransactionsPageType } from "client/components";
import { Transaction } from "../../lib/models/Transaction";
import { SplitTransaction } from "../../lib/models/SplitTransaction";
import { InvestmentTransaction } from "../../lib/models/InvestmentTransaction";
import { TransferDictionary } from "../../lib/models/Data";
import type { TransferPair } from "server";

// Thin per-test wrapper around the class API so the assertions stay in
// the `predicate(row, types, ctx)` shape. Each call constructs its own
// `TypePredicates` — fine for tests; in production code the class is
// instantiated once per `filteredAndSorted` memo pass.
const matchesAnySelectedType = (
  e: Transaction | SplitTransaction,
  types: TransactionsPageType[],
  ctx: FilterContext,
): boolean => new TypePredicates(ctx).any(types)(e);

const DATE = "2026-03-15";

const makeTxn = (
  id: string,
  amount: number,
  label: { category_id?: string | null; category_confidence?: number | null } = {},
): Transaction =>
  new Transaction({
    account_id: "acc-1",
    transaction_id: id,
    amount,
    date: DATE,
    label,
  });

const makeSplit = (
  id: string,
  parent_id: string,
  amount: number,
  label: { category_id?: string | null; category_confidence?: number | null } = {},
): SplitTransaction =>
  new SplitTransaction({
    split_transaction_id: id,
    transaction_id: parent_id,
    account_id: "acc-1",
    amount,
    label,
  });

const makePair = (
  pair_id: string,
  status: "suggested" | "confirmed" | "rejected",
  txnIds: string[],
): TransferPair =>
  ({
    pair_id,
    status,
    transactions: txnIds.map((id) => ({ transaction_id: id }) as never),
  }) as TransferPair;

const makeCtx = (pairs: TransferPair[] = []): FilterContext => {
  const transfers = new TransferDictionary();
  pairs.forEach((p) => transfers.set(p.pair_id, p));
  return { transfers };
};

describe("isSuggestedLabel", () => {
  // Build rows through makeTxn so `label` is a real TransactionLabel (as it
  // always is in production — every row constructor wraps its init label),
  // which is what `label.isSuggested()` reads.
  test("category_id + confidence in (0,1) → suggested", () => {
    expect(isSuggestedLabel(makeTxn("t1", 0, { category_id: "c", category_confidence: 0.5 }))).toBe(
      true,
    );
  });
  test("confidence = 1 → confirmed, not suggested", () => {
    expect(isSuggestedLabel(makeTxn("t1", 0, { category_id: "c", category_confidence: 1 }))).toBe(
      false,
    );
  });
  test("confidence = 0 → rejected, not suggested", () => {
    expect(isSuggestedLabel(makeTxn("t1", 0, { category_id: "c", category_confidence: 0 }))).toBe(
      false,
    );
  });
  test("no category_id → not suggested", () => {
    expect(isSuggestedLabel(makeTxn("t1", 0, { category_confidence: 0.5 }))).toBe(false);
  });
  test("null confidence → not suggested", () => {
    expect(isSuggestedLabel(makeTxn("t1", 0, { category_id: "c", category_confidence: null }))).toBe(
      false,
    );
  });
});

describe("matchesAnySelectedType — basics", () => {
  test("empty list matches everything", () => {
    expect(matchesAnySelectedType(makeTxn("t1", 10), [], makeCtx())).toBe(true);
  });
  test("multi-select OR: matches if any type matches", () => {
    // amount > 0 → matches "expenses" but not "deposits"; "transfers" doesn't match.
    expect(
      matchesAnySelectedType(makeTxn("t1", 10), ["deposits", "expenses"], makeCtx()),
    ).toBe(true);
  });
});

describe("matchesAnySelectedType — deposits / expenses", () => {
  test("deposits: amount < 0", () => {
    expect(matchesAnySelectedType(makeTxn("t1", -5), ["deposits"], makeCtx())).toBe(true);
    expect(matchesAnySelectedType(makeTxn("t1", 5), ["deposits"], makeCtx())).toBe(false);
  });
  test("expenses: amount > 0", () => {
    expect(matchesAnySelectedType(makeTxn("t1", 5), ["expenses"], makeCtx())).toBe(true);
    expect(matchesAnySelectedType(makeTxn("t1", -5), ["expenses"], makeCtx())).toBe(false);
  });
  test("confirmed-transfer half is excluded from expenses AND deposits", () => {
    // A confirmed transfer must NOT surface under the expenses/deposits title
    // filter — getBudgetData already excludes it from totals, and it's neither
    // income nor expense.
    const expense = makeTxn("t1", 5);
    const deposit = makeTxn("t2", -5);
    const ctx = makeCtx([
      makePair("p1", "confirmed", ["t1", "x1"]),
      makePair("p2", "confirmed", ["t2", "x2"]),
    ]);
    expect(matchesAnySelectedType(expense, ["expenses"], ctx)).toBe(false);
    expect(matchesAnySelectedType(deposit, ["deposits"], ctx)).toBe(false);
  });
  test("SUGGESTED-transfer half still matches expenses/deposits (counts toward budget until confirmed)", () => {
    // Only confirmed transfers are excluded from budget totals, so a
    // suggested transfer half must still appear under expenses/deposits.
    const expense = makeTxn("t1", 5);
    const deposit = makeTxn("t2", -5);
    const ctx = makeCtx([
      makePair("p1", "suggested", ["t1", "x1"]),
      makePair("p2", "suggested", ["t2", "x2"]),
    ]);
    expect(matchesAnySelectedType(expense, ["expenses"], ctx)).toBe(true);
    expect(matchesAnySelectedType(deposit, ["deposits"], ctx)).toBe(true);
  });
});

describe("matchesAnySelectedType — unsorted", () => {
  test("no category_id → unsorted", () => {
    expect(matchesAnySelectedType(makeTxn("t1", 5), ["unsorted"], makeCtx())).toBe(true);
  });
  test("suggested category → unsorted (widening: 'not user-confirmed')", () => {
    expect(
      matchesAnySelectedType(
        makeTxn("t1", 5, { category_id: "c", category_confidence: 0.5 }),
        ["unsorted"],
        makeCtx(),
      ),
    ).toBe(true);
  });
  test("confirmed category (conf=1) → NOT unsorted", () => {
    expect(
      matchesAnySelectedType(
        makeTxn("t1", 5, { category_id: "c", category_confidence: 1 }),
        ["unsorted"],
        makeCtx(),
      ),
    ).toBe(false);
  });
  test("category_id set + conf=0 → unsorted (legacy write-path corruption, not user-acted)", () => {
    // conf=0 with a non-null category_id is not producible by the current
    // write path: `inferLabelConfidence` maps a set category to conf=1, and
    // a rejection clears category_id to null + writes to
    // `rejected_categories`. Any row still in this state is legacy
    // corruption from an older `updateSplitTransactions` path. Aligning
    // here with `Label.isConfirmed()` (conf===1 && category_id) keeps the
    // count in `budgets.ts` and the list here on the same predicate.
    expect(
      matchesAnySelectedType(
        makeTxn("t1", 5, { category_id: "c", category_confidence: 0 }),
        ["unsorted"],
        makeCtx(),
      ),
    ).toBe(true);
  });
  test("confirmed-transfer half is excluded from unsorted (transfer state takes precedence)", () => {
    // A half of a confirmed transfer pair whose category is still suggested
    // must NOT surface under "unsorted" even though the category isn't
    // user-confirmed — the transfer is "done" from the user's POV.
    const txn = makeTxn("t1", 5, { category_id: "c", category_confidence: 0.5 });
    const ctx = makeCtx([makePair("p1", "confirmed", ["t1", "t2"])]);
    expect(matchesAnySelectedType(txn, ["unsorted"], ctx)).toBe(false);
  });
});

describe("matchesAnySelectedType — suggested", () => {
  test("suggested category → matches", () => {
    expect(
      matchesAnySelectedType(
        makeTxn("t1", 5, { category_id: "c", category_confidence: 0.5 }),
        ["suggested"],
        makeCtx(),
      ),
    ).toBe(true);
  });
  test("no category → does NOT match suggested", () => {
    expect(matchesAnySelectedType(makeTxn("t1", 5), ["suggested"], makeCtx())).toBe(false);
  });
  test("confirmed-transfer half is excluded from suggested even with a suggested category", () => {
    // A row with confidence 0.5 whose transfer pair is already confirmed must
    // NOT surface under the suggested filter — the user already acted on it.
    const txn = makeTxn("t1", 5, { category_id: "c", category_confidence: 0.5 });
    const ctx = makeCtx([makePair("p1", "confirmed", ["t1", "t2"])]);
    expect(matchesAnySelectedType(txn, ["suggested"], ctx)).toBe(false);
  });
  test("suggested transfer-pair half (no category label) → matches suggested", () => {
    // An unlabeled row that's a half of a SUGGESTED pair must match the
    // suggested filter — the Accept-All count includes it.
    const txn = makeTxn("t1", 5); // no category label at all
    const ctx = makeCtx([makePair("p1", "suggested", ["t1", "t2"])]);
    expect(matchesAnySelectedType(txn, ["suggested"], ctx)).toBe(true);
  });
});

describe("matchesAnySelectedType — transfers", () => {
  test("confirmed-transfer half → matches transfers", () => {
    const txn = makeTxn("t1", 5);
    const ctx = makeCtx([makePair("p1", "confirmed", ["t1", "t2"])]);
    expect(matchesAnySelectedType(txn, ["transfers"], ctx)).toBe(true);
  });
  test("suggested-transfer half → matches transfers", () => {
    const txn = makeTxn("t1", 5);
    const ctx = makeCtx([makePair("p1", "suggested", ["t1", "t2"])]);
    expect(matchesAnySelectedType(txn, ["transfers"], ctx)).toBe(true);
  });
  test("non-transfer row → does NOT match transfers", () => {
    expect(matchesAnySelectedType(makeTxn("t1", 5), ["transfers"], makeCtx())).toBe(false);
  });
});

describe("matchesAnySelectedType — split-transaction guard", () => {
  test("a SplitTransaction whose parent is in a transfer pair does NOT match transfers", () => {
    // Splits inherit their parent's transaction_id; an unguarded lookup
    // would resolve the PARENT's pair and leak split rows into Transfers.
    const split = makeSplit("s1", "t1", 3);
    const ctx = makeCtx([makePair("p1", "confirmed", ["t1", "t2"])]);
    expect(matchesAnySelectedType(split, ["transfers"], ctx)).toBe(false);
  });
  test("a SplitTransaction of a confirmed-transfer parent is EXCLUDED from every budget-semantic filter (matches getBudgetData)", () => {
    // getBudgetData drops a split whose parent is a confirmed transfer from
    // ALL budget buckets, keyed on the parent transaction_id (the split
    // inherits it). The budget-semantic filters must match — so this split
    // is excluded from unsorted/suggested/expenses/deposits regardless of
    // its own label. Only the `transfers` view (render classification) keys
    // on the row's own identity, where the split correctly does NOT appear.
    const split = makeSplit("s1", "t1", 3, { category_id: "c", category_confidence: 0.5 });
    const ctx = makeCtx([makePair("p1", "confirmed", ["t1", "t2"])]);
    expect(matchesAnySelectedType(split, ["suggested"], ctx)).toBe(false);
    expect(matchesAnySelectedType(split, ["unsorted"], ctx)).toBe(false);
    expect(matchesAnySelectedType(split, ["expenses"], ctx)).toBe(false);
  });
  test("a SplitTransaction of a SUGGESTED-transfer parent still follows its own label (not yet budget-excluded)", () => {
    // Only CONFIRMED transfers are excluded from budget. A split of a
    // merely-suggested transfer parent still counts, so it follows its own
    // label like any normal split.
    const split = makeSplit("s1", "t1", 3, { category_id: "c", category_confidence: 0.5 });
    const ctx = makeCtx([makePair("p1", "suggested", ["t1", "t2"])]);
    expect(matchesAnySelectedType(split, ["suggested"], ctx)).toBe(true);
    expect(matchesAnySelectedType(split, ["unsorted"], ctx)).toBe(true);
  });
});

describe("TypePredicates.any — investment branch", () => {
  const investAccount = "inv-acc-1";
  const mkInv = (amount: number): InvestmentTransaction =>
    new InvestmentTransaction({
      account_id: investAccount,
      type: InvestmentTransactionType.Buy,
      subtype: InvestmentTransactionSubtype.Buy,
      quantity: 1,
      price: amount,
      amount,
      date: "2026-02-15",
    });

  const investMatch = (e: InvestmentTransaction, types: TransactionsPageType[]): boolean =>
    new TypePredicates(makeCtx()).any(types)(e);

  test("empty list matches everything", () => {
    expect(investMatch(mkInv(50), [])).toBe(true);
  });
  test("non-sign types don't match an investment row (no label/transfer semantic to filter on)", () => {
    expect(investMatch(mkInv(50), ["unsorted"])).toBe(false);
    expect(investMatch(mkInv(50), ["suggested"])).toBe(false);
    expect(investMatch(mkInv(50), ["transfers"])).toBe(false);
  });
  test("deposits / expenses respected", () => {
    expect(investMatch(mkInv(50), ["expenses"])).toBe(true);
    expect(investMatch(mkInv(50), ["deposits"])).toBe(false);
    expect(investMatch(mkInv(-50), ["deposits"])).toBe(true);
  });
  test("mixed (sign + non-sign): sign rules; non-sign always false", () => {
    expect(investMatch(mkInv(50), ["expenses", "transfers"])).toBe(true);
    expect(investMatch(mkInv(-50), ["expenses", "transfers"])).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Accept-All button count invariants — mirrored on the button in
// `TransactionsPage/index.tsx`. The button count and the button action must
// agree, and neither may include confirmed transfer halves (which have already
// been accepted even though the row still carries a suggested confidence).
// -----------------------------------------------------------------------------

describe("isAcceptableSuggestion", () => {
  test("engine-labeled non-transfer row is acceptable", () => {
    const row = makeTxn("t1", 10, { category_id: "c", category_confidence: 0.7 });
    expect(isAcceptableSuggestion(row, makeCtx())).toBe(true);
  });

  test("engine-labeled half of a SUGGESTED pair is acceptable", () => {
    const row = makeTxn("t-a", 10, { category_id: "c", category_confidence: 0.7 });
    const ctx = makeCtx([makePair("p1", "suggested", ["t-a", "t-b"])]);
    expect(isAcceptableSuggestion(row, ctx)).toBe(true);
  });

  test("engine-labeled half of a CONFIRMED pair is NOT acceptable (transfer state wins)", () => {
    // `confirmTransferPair` doesn't rewrite the halves' `category_confidence`,
    // so a row can hold a still-suggested category label while its pair is
    // confirmed. Accept-All must not count or act on it.
    const row = makeTxn("t-a", 10, { category_id: "c", category_confidence: 0.7 });
    const ctx = makeCtx([makePair("p1", "confirmed", ["t-a", "t-b"])]);
    expect(isAcceptableSuggestion(row, ctx)).toBe(false);
  });

  test("user-confirmed label (confidence=1) is NOT acceptable", () => {
    const row = makeTxn("t1", 10, { category_id: "c", category_confidence: 1 });
    expect(isAcceptableSuggestion(row, makeCtx())).toBe(false);
  });

  test("user-rejected label (confidence=0) is NOT acceptable", () => {
    const row = makeTxn("t1", 10, { category_id: "c", category_confidence: 0 });
    expect(isAcceptableSuggestion(row, makeCtx())).toBe(false);
  });

  test("SPLIT of a confirmed-transfer parent is NOT acceptable (transfer state cascades to splits)", () => {
    // Splits inherit parent's transaction_id, so `isInConfirmedTransfer`
    // returns true for them too — Accept-All must not surface a still-
    // engine-labeled split whose parent is a confirmed transfer half.
    const split = makeSplit("s1", "t-a", 5, {
      category_id: "c",
      category_confidence: 0.5,
    });
    const ctx = makeCtx([makePair("p1", "confirmed", ["t-a", "t-b"])]);
    expect(isAcceptableSuggestion(split, ctx)).toBe(false);
  });

  test("InvestmentTransaction with suggested label IS acceptable (no transfer semantics)", () => {
    const inv = new InvestmentTransaction({
      account_id: "inv-acc-1",
      type: InvestmentTransactionType.Buy,
      subtype: InvestmentTransactionSubtype.Buy,
      quantity: 1,
      price: 10,
      amount: 10,
      date: "2026-02-15",
      label: { category_id: "c", category_confidence: 0.5 },
    });
    expect(isAcceptableSuggestion(inv, makeCtx())).toBe(true);
  });
});

describe("pickAcceptableTransferPairs", () => {
  test("picks a suggested pair when one half is in-view", () => {
    const half = makeTxn("t-a", 10);
    const ctx = makeCtx([makePair("p1", "suggested", ["t-a", "t-b"])]);
    expect(pickAcceptableTransferPairs([half], ctx.transfers)).toEqual([{ pair_id: "p1" }]);
  });

  test("does NOT pick a CONFIRMED pair even if a half is visible", () => {
    const half = makeTxn("t-a", 10);
    const ctx = makeCtx([makePair("p1", "confirmed", ["t-a", "t-b"])]);
    expect(pickAcceptableTransferPairs([half], ctx.transfers)).toEqual([]);
  });

  test("does NOT pick a REJECTED pair", () => {
    const half = makeTxn("t-a", 10);
    const ctx = makeCtx([makePair("p1", "rejected", ["t-a", "t-b"])]);
    expect(pickAcceptableTransferPairs([half], ctx.transfers)).toEqual([]);
  });

  test("does NOT pick a pair when a split of a half — not the half itself — is in view", () => {
    // Pre-fix, visibleIds was built from `rows.map(e => e.id)`, which for a
    // SplitTransaction is `split_transaction_id`, not `transaction_id`. The
    // pair-intersect check then compared apples to oranges. The fix uses a
    // whole-transaction-only visibility set — a suggested pair whose half is
    // only present as a split can't be Accept-All'd (the whole isn't visible
    // to click, so it stays a manual per-row action).
    const split = makeSplit("s1", "t-a", 5);
    const ctx = makeCtx([makePair("p1", "suggested", ["t-a", "t-b"])]);
    expect(pickAcceptableTransferPairs([split], ctx.transfers)).toEqual([]);
  });

  test("does NOT pick a pair whose halves are entirely out of view", () => {
    const other = makeTxn("t-c", 10);
    const ctx = makeCtx([makePair("p1", "suggested", ["t-a", "t-b"])]);
    expect(pickAcceptableTransferPairs([other], ctx.transfers)).toEqual([]);
  });

  test("de-dupes by pair_id when both halves are visible", () => {
    const halfA = makeTxn("t-a", 10);
    const halfB = makeTxn("t-b", -10);
    const ctx = makeCtx([makePair("p1", "suggested", ["t-a", "t-b"])]);
    expect(pickAcceptableTransferPairs([halfA, halfB], ctx.transfers)).toEqual([
      { pair_id: "p1" },
    ]);
  });
});

describe("matchesAnySelectedType — manual", () => {
  const mkTxn = (id: string, source: string): Transaction => {
    const t = makeTxn(id, 10);
    t.source = source;
    return t;
  };
  const mkInv = (source: string): InvestmentTransaction => {
    const t = new InvestmentTransaction({
      account_id: "inv-acc-1",
      type: InvestmentTransactionType.Buy,
      subtype: InvestmentTransactionSubtype.Buy,
      quantity: 1,
      price: 10,
      amount: 10,
      date: "2026-02-15",
    });
    t.source = source;
    return t;
  };

  test("Transaction source='manual' matches", () => {
    expect(matchesAnySelectedType(mkTxn("t1", "manual"), ["manual"], makeCtx())).toBe(true);
  });
  test("Transaction source='plaid' does not match", () => {
    expect(matchesAnySelectedType(mkTxn("t1", "plaid"), ["manual"], makeCtx())).toBe(false);
  });
  test("InvestmentTransaction source='manual' matches", () => {
    expect(new TypePredicates(makeCtx()).any(["manual"])(mkInv("manual"))).toBe(true);
  });
  test("InvestmentTransaction source='plaid' does not match", () => {
    expect(new TypePredicates(makeCtx()).any(["manual"])(mkInv("plaid"))).toBe(false);
  });
  test("SplitTransaction never matches (splits inherit parent source but carry no field of their own)", () => {
    // A split can't itself declare source='manual'; the parent's source is
    // what matters, and today's manual mint flow doesn't create splits.
    expect(matchesAnySelectedType(makeSplit("s1", "t1", 5), ["manual"], makeCtx())).toBe(false);
  });
  test("manual + deposits (multi-select): OR — a Plaid deposit matches under 'deposits'", () => {
    const plaidDeposit = mkTxn("t1", "plaid");
    plaidDeposit.amount = -5;
    expect(matchesAnySelectedType(plaidDeposit, ["manual", "deposits"], makeCtx())).toBe(true);
  });
});
