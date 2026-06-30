// Run with: bun test --preload ./scripts/test-preload.ts filter.test.ts
import { describe, test, expect } from "bun:test";
import { InvestmentTransactionType, InvestmentTransactionSubtype } from "plaid";

import { isSuggestedLabel, TypePredicates, type FilterContext } from "./filter";
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
  test("category_id + confidence in (0,1) → suggested", () => {
    expect(isSuggestedLabel({ label: { category_id: "c", category_confidence: 0.5 } })).toBe(true);
  });
  test("confidence = 1 → confirmed, not suggested", () => {
    expect(isSuggestedLabel({ label: { category_id: "c", category_confidence: 1 } })).toBe(false);
  });
  test("confidence = 0 → rejected, not suggested", () => {
    expect(isSuggestedLabel({ label: { category_id: "c", category_confidence: 0 } })).toBe(false);
  });
  test("no category_id → not suggested", () => {
    expect(isSuggestedLabel({ label: { category_confidence: 0.5 } })).toBe(false);
  });
  test("null confidence → not suggested", () => {
    expect(isSuggestedLabel({ label: { category_id: "c", category_confidence: null } })).toBe(
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
    // Bug Hoie flagged on #569: a confirmed transfer was shown under the
    // expenses/deposits title filter even though getBudgetData excludes it
    // from totals. A confirmed transfer is neither income nor expense.
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
  test("rejected category (conf=0) → NOT unsorted", () => {
    expect(
      matchesAnySelectedType(
        makeTxn("t1", 5, { category_id: "c", category_confidence: 0 }),
        ["unsorted"],
        makeCtx(),
      ),
    ).toBe(false);
  });
  test("confirmed-transfer half is excluded from unsorted (transfer state takes precedence)", () => {
    // A half of a confirmed transfer pair whose category is still suggested:
    // pre-PR this passed "unsorted" because the category check widened to
    // 'not user-confirmed'. The transfer is "done" from the user's POV;
    // exclude it.
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
    // Bug Hoie reported: pre-PR this row showed up under the suggested
    // filter because the confidence is 0.5. Confirmed transfers should
    // be excluded — the user already acted on them.
    const txn = makeTxn("t1", 5, { category_id: "c", category_confidence: 0.5 });
    const ctx = makeCtx([makePair("p1", "confirmed", ["t1", "t2"])]);
    expect(matchesAnySelectedType(txn, ["suggested"], ctx)).toBe(false);
  });
  test("suggested transfer-pair half (no category label) → matches suggested", () => {
    // Bug 2: pre-PR an unlabeled row that's a half of a SUGGESTED pair
    // didn't match the suggested filter, even though the Accept-All
    // count included it (asymmetric UX). Now it does.
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
