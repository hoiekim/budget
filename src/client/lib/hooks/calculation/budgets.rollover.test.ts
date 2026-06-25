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
import { Category } from "../../models/Category";
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

// Regression coverage for #545: the warm-load accrual loop iterated
// `budgetData`'s existing keys, so it only ran for budget-likes a confirmed
// (or, for budgets, any) transaction had touched. A rollover-enabled
// budget-like with zero such transactions never got a `budgetData` entry, its
// accrual never ran, and the bar rendered "+ 0 rolled" despite a real capacity
// and a years-old `roll_over_start_date`. The fix drives the accrual over the
// budget/section/category dictionaries instead, so the carry is independent of
// transaction presence.
describe("getBudgetData rollover accrues without transactions (#545)", () => {
  const OLD_START = "2022-06-01";
  const SPEND = 50;

  const makeTwoBudgets = (): BudgetDictionary => {
    const dict = new BudgetDictionary();
    // Byte-identical config; the only difference will be that bud-with gets a
    // single transaction and bud-zero gets none.
    for (const id of ["bud-with", "bud-zero"]) {
      const b = new Budget({
        budget_id: id,
        user_id: "u1",
        name: id,
        iso_currency_code: "USD",
        capacities: [
          { active_from: null, children: {}, year: MONTHLY_CAPACITY * 12, month: MONTHLY_CAPACITY, week: 0, day: 0 },
        ],
        roll_over: true,
        roll_over_start_date: OLD_START,
      });
      dict.set(b.budget_id, b);
    }
    return dict;
  };

  const makeAccountFor = (budgetId: string): AccountDictionary => {
    const a = new Account({
      account_id: "acc-1",
      name: "Checking",
      type: "depository" as never,
      subtype: "checking" as never,
      label: { budget_id: budgetId, category_id: null },
    } as never);
    const dict = new AccountDictionary();
    dict.set(a.account_id, a);
    return dict;
  };

  const makeSpendOn = (budgetId: string): TransactionDictionary => {
    const dict = new TransactionDictionary();
    const d = new ViewDate("month").previous(); // last month → rolls into this month
    const t = new Transaction({
      transaction_id: "txn-with",
      account_id: "acc-1",
      name: "Coffee",
      merchant_name: "Cafe",
      amount: SPEND,
      date: d.getStartDate().toISOString().slice(0, 10),
      pending: false,
      label: { budget_id: budgetId, category_id: null },
    } as never);
    dict.set(t.transaction_id, t);
    return dict;
  };

  const runTwoBudgets = () => {
    const { budgetData } = getBudgetData(
      makeSpendOn("bud-with"),
      emptySplits(),
      makeAccountFor("bud-with"),
      makeTwoBudgets(),
      emptySections(),
      emptyCategories(),
      new TransferDictionary(),
      false, // warm / steady state
    );
    const now = new ViewDate("month").getEndDate();
    return {
      withTxn: budgetData.get("bud-with", now).rolled_over_amount,
      zeroTxn: budgetData.get("bud-zero", now).rolled_over_amount,
    };
  };

  test("a budget with zero transactions still accrues its capacity carry (not the buggy 0)", () => {
    const { zeroTxn } = runTwoBudgets();
    // Full-span capacity carry with no offsetting spending → strongly negative
    // surplus. The bug rendered exactly 0 here.
    expect(zeroTxn).toBeLessThan(0);
  });

  test("zero-txn and with-txn carries differ by exactly the single spend (A/B divergence is only the spend)", () => {
    const { withTxn, zeroTxn } = runTwoBudgets();
    // Identical config; the one 50 spend on bud-with reduces its surplus by
    // exactly that amount. Before the fix, zeroTxn was 0 and the two diverged
    // by the whole multi-year accrual.
    expect(withTxn).toBeCloseTo(zeroTxn + SPEND, 6);
  });

  test("a rollover category with zero transactions accrues (section/category path)", () => {
    const categories = new CategoryDictionary();
    const c = new Category({
      category_id: "cat-1",
      section_id: "sec-1",
      name: "Untouched Category",
      capacities: [
        { active_from: null, children: {}, year: MONTHLY_CAPACITY * 12, month: MONTHLY_CAPACITY, week: 0, day: 0 },
      ],
      roll_over: true,
      roll_over_start_date: OLD_START,
    } as never);
    categories.set(c.category_id, c);

    const { budgetData } = getBudgetData(
      new TransactionDictionary(),
      emptySplits(),
      new AccountDictionary(),
      new BudgetDictionary(),
      emptySections(),
      categories,
      new TransferDictionary(),
      false,
    );
    const now = new ViewDate("month").getEndDate();
    // The category is touched by no transaction at all, so under the old
    // budgetData-keyed loop its accrual never ran and it read 0.
    expect(budgetData.get("cat-1", now).rolled_over_amount).toBeLessThan(0);
  });
});
