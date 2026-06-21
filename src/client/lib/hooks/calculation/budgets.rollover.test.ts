// Run with: bun test --preload ./scripts/test-preload.ts budgets.rollover.test.ts
//
// Regression coverage for #484: on a cold load the rollover ("+ $X rolled")
// accrued a month of capacity for EVERY month from roll_over_start_date to now,
// but spending only existed for the subset of months whose transactions had
// streamed in — so the figure overstated (~12× in prod) until the full history
// loaded. getBudgetData now takes `isColdSync`; when set, it skips the accrual
// loop entirely so the figure stays at 0 until Stage 4 commits the full
// history. Reason: under the new delta-by-cursor sync the loaded subset is
// keyed by `updated`, not `date`, so back-edited rows from years ago appear in
// Stage 2 with no relation to "the last N months of history" — the axis
// mismatch is unfixable until the full history lands.

import { describe, test, expect } from "bun:test";
import { LocalDate, ViewDate } from "common";
import { getBudgetData } from "./budgets";
import {
  TransactionDictionary,
  SplitTransactionDictionary,
  AccountDictionary,
  BudgetDictionary,
  SectionDictionary,
  CategoryDictionary,
  TransferDictionary,
} from "../../models/Data";
import { Transaction } from "../../models/Transaction";
import { Budget } from "../../models/Budget";
import { Account } from "../../models/Account";

const MONTHLY_CAPACITY = 100;

const makeBudget = (rollOverStart: string): BudgetDictionary => {
  const b = new Budget({
    budget_id: "bud-1",
    user_id: "u1",
    name: "Rolling Budget",
    iso_currency_code: "USD",
    capacities: [{ active_from: null, children: {}, year: MONTHLY_CAPACITY * 12, month: MONTHLY_CAPACITY, week: 0, day: 0 }],
    roll_over: true,
    roll_over_start_date: rollOverStart,
  });
  const dict = new BudgetDictionary();
  dict.set(b.budget_id, b);
  return dict;
};

const emptySections = () => new SectionDictionary();
const emptyCategories = () => new CategoryDictionary();
const emptySplits = () => new SplitTransactionDictionary();

const makeAccount = (): AccountDictionary => {
  const a = new Account({
    account_id: "acc-1",
    name: "Checking",
    type: "depository" as never,
    subtype: "checking" as never,
    label: { budget_id: "bud-1", category_id: null },
  } as never);
  const dict = new AccountDictionary();
  dict.set(a.account_id, a);
  return dict;
};

const makeTransactions = (monthsAgo: number): TransactionDictionary => {
  const dict = new TransactionDictionary();
  const d = new ViewDate("month").previous();
  for (let i = 1; i < monthsAgo; i++) d.previous();
  const t = new Transaction({
    transaction_id: `txn-${monthsAgo}`,
    account_id: "acc-1",
    name: "Coffee",
    merchant_name: "Cafe",
    amount: 50,
    date: d.getStartDate().toISOString().slice(0, 10),
    pending: false,
    label: { budget_id: "bud-1", category_id: null },
  } as never);
  dict.set(t.transaction_id, t);
  return dict;
};

const rolledThisMonth = (
  rollOverStart: string,
  transactions: TransactionDictionary,
  isColdSync: boolean,
) => {
  const { budgetData } = getBudgetData(
    transactions,
    emptySplits(),
    makeAccount(),
    makeBudget(rollOverStart),
    emptySections(),
    emptyCategories(),
    new TransferDictionary(),
    isColdSync,
  );
  return budgetData.get("bud-1", new ViewDate("month").getEndDate()).rolled_over_amount;
};

describe("getBudgetData rollover cold-sync skip (#484)", () => {
  const txns = makeTransactions(1);
  const OLD_START = "2022-06-01";

  test("warm load accrues capacity over the full span (steady-state, unchanged)", () => {
    const complete = rolledThisMonth(OLD_START, txns, false);
    const start = new ViewDate("month", new LocalDate(OLD_START)).next();
    const now = new ViewDate("month");
    let months = 0;
    const cursor = start.clone();
    while (cursor.getEndDate() <= now.getEndDate()) {
      months++;
      cursor.next();
    }
    // Full-span accrual is strongly negative (capacity per month, no offsetting
    // spending except the single recent txn). This is the correct value once the
    // whole history is loaded — the fix must NOT change it.
    expect(complete).toBeLessThan(-MONTHLY_CAPACITY * (months - 2));
  });

  test("cold sync skips accrual entirely — rollover shows as 0", () => {
    // With isColdSync=true, the rollover map carries no entry for this month
    // (the accrual loop never ran). BudgetData.get returns a default-zero
    // summary, so rolled_over_amount reads as 0.
    const cold = rolledThisMonth(OLD_START, txns, true);
    expect(cold).toBe(0);
  });

  test("cold + zero transactions also shows 0 (Stage 1)", () => {
    const cold = rolledThisMonth(OLD_START, new TransactionDictionary(), true);
    expect(cold).toBe(0);
  });

  test("cold sync result is independent of whichever transactions happen to be loaded", () => {
    // Stage-1 (empty) and Stage-2 (back-edited rows from years ago) must give
    // the same 0 carry — the bug was that the clamp inferred "history loaded
    // from year X" from sparse rows and overstated the accrual span.
    const stage1 = rolledThisMonth(OLD_START, new TransactionDictionary(), true);
    const stage2 = rolledThisMonth(OLD_START, txns, true);
    expect(stage1).toBe(stage2);
  });
});
