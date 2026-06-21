// Run with: bun test --preload ./scripts/test-preload.ts budgets.rollover.test.ts
//
// Regression coverage for #484: on a cold load the rollover ("+ $X rolled")
// accrued a month of capacity for EVERY month from roll_over_start_date to now,
// but spending only existed for the subset of months whose transactions had
// streamed in — so the figure overstated (~12× in prod) until the full history
// loaded. getBudgetData now takes `isTransactionHistoryPartial`; when set it
// clamps the accrual to the earliest loaded transaction month so the capacity
// and spending axes span the same window.

import { describe, test, expect } from "bun:test";
import { ViewDate, LocalDate } from "common";
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
import { Account } from "../../models/Account";
import { Transaction } from "../../models/Transaction";
import { Budget } from "../../models/Budget";

const ACCOUNT_ID = "acc-1";
const MONTHLY_CAPACITY = 100;

const makeAccount = () => {
  const dict = new AccountDictionary();
  dict.set(ACCOUNT_ID, new Account({ account_id: ACCOUNT_ID, hide: false }));
  return dict;
};

const makeBudget = (rollOverStart: string) => {
  const dict = new BudgetDictionary();
  const budget = new Budget({
    budget_id: "bud-1",
    name: "Test",
    roll_over: true,
    roll_over_start_date: rollOverStart,
    capacities: [{ month: MONTHLY_CAPACITY, is_synced: false }],
  });
  dict.set(budget.budget_id, budget);
  return dict;
};

// One unconfirmed transaction (unsorted path) labeled directly to the budget,
// dated `monthsAgo` months before the current month.
const makeTransactions = (monthsAgo: number) => {
  const dict = new TransactionDictionary();
  let vd = new ViewDate("month");
  for (let i = 0; i < monthsAgo; i++) vd = vd.previous();
  const dateStr = vd.getEndDate().toISOString().slice(0, 10);
  dict.set(
    "txn-1",
    new Transaction({
      transaction_id: "txn-1",
      account_id: ACCOUNT_ID,
      amount: 30,
      date: dateStr,
      label: { budget_id: "bud-1" },
    }),
  );
  return dict;
};

const emptySplits = () => new SplitTransactionDictionary();
const emptySections = () => new SectionDictionary();
const emptyCategories = () => new CategoryDictionary();

const rolledThisMonth = (
  rollOverStart: string,
  transactions: TransactionDictionary,
  partial: boolean,
) => {
  const { budgetData } = getBudgetData(
    transactions,
    emptySplits(),
    makeAccount(),
    makeBudget(rollOverStart),
    emptySections(),
    emptyCategories(),
    new TransferDictionary(),
    partial,
  );
  return budgetData.get("bud-1", new ViewDate("month").getEndDate()).rolled_over_amount;
};

describe("getBudgetData rollover cold-load clamp (#484)", () => {
  // Transaction one month back simulates a Stage-2 cold load: only the most
  // recent month is in memory while roll_over_start_date sits years earlier.
  const txns = makeTransactions(1);
  const OLD_START = "2022-06-01";

  test("complete load accrues capacity over the full span (steady-state, unchanged)", () => {
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

  test("partial load clamps accrual to the loaded window — never overstates", () => {
    const partial = rolledThisMonth(OLD_START, txns, true);
    const complete = rolledThisMonth(OLD_START, txns, false);
    // Clamped figure is far smaller in magnitude than the full-span accrual...
    expect(Math.abs(partial)).toBeLessThan(Math.abs(complete));
    // ...and bounded by a couple of months of capacity, not the multi-year span.
    expect(Math.abs(partial)).toBeLessThanOrEqual(MONTHLY_CAPACITY * 3);
    // The overstatement was a large negative carry; clamped must be less negative.
    expect(partial).toBeGreaterThan(complete);
  });

  test("clamp(partial, old start) === complete run started at the earliest loaded month", () => {
    const partial = rolledThisMonth(OLD_START, txns, true);
    // The earliest loaded transaction is one month ago; a complete run whose
    // roll_over_start_date IS that month must produce the same clamped value.
    const earliestMonthStart = new ViewDate("month").previous().getStartDate().toISOString().slice(0, 10);
    const equivalent = rolledThisMonth(earliestMonthStart, txns, false);
    expect(partial).toBeCloseTo(equivalent, 6);
  });

  test("no loaded transactions (Stage 1) shows no inflated rollover", () => {
    const partial = rolledThisMonth(OLD_START, new TransactionDictionary(), true);
    expect(partial).toBe(0);
  });
});
