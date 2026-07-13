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

// Regression coverage for #562: the accrual loop only writes rollover entries
// up to the current calendar month. When the user paged the Budgets/Balance
// view forward, `budgetData.get(id, futureMonth)` returned a lazily-created
// empty summary so the bar rendered "+ $0 rolled" while capacity and "left"
// kept projecting forward. getRolledOver now projects the carry forward
// on read for future months, mirroring how capacity already projects.
describe("BudgetData.getRolledOver future-month projection (#562)", () => {
  const OLD_START = "2022-06-01";

  const buildBudgetData = () => {
    const { budgetData } = getBudgetData(
      new TransactionDictionary(),
      emptySplits(),
      makeAccount(),
      makeBudget(OLD_START),
      emptySections(),
      emptyCategories(),
      new TransferDictionary(),
      false, // warm / steady state
    );
    return budgetData;
  };

  const budget = () => makeBudget(OLD_START).get("bud-1")!;

  test("current month equals the accrued value (authoritative — unchanged)", () => {
    const budgetData = buildBudgetData();
    const now = new ViewDate("month").getEndDate();
    const stored = budgetData.get("bud-1", now).rolled_over_amount;
    expect(budgetData.getRolledOver(budget(), now)).toBe(stored);
  });

  test("future months keep accruing one capacity step each — they do NOT reset to 0", () => {
    const budgetData = buildBudgetData();
    const now = new ViewDate("month").getEndDate();
    const current = budgetData.getRolledOver(budget(), now);

    const oneAhead = new ViewDate("month").next().getEndDate();
    const twoAhead = new ViewDate("month").next(2).getEndDate();

    const r1 = budgetData.getRolledOver(budget(), oneAhead);
    const r2 = budgetData.getRolledOver(budget(), twoAhead);

    // The bug: r1 === 0. Fixed: rollover is stored negative (renders "+"),
    // so each future month with no spend grows the surplus by exactly one
    // month's capacity — strictly more negative than the current month.
    expect(r1).not.toBe(0);
    expect(r1).toBeCloseTo(current - MONTHLY_CAPACITY, 6);
    expect(r2).toBeCloseTo(current - 2 * MONTHLY_CAPACITY, 6);
  });

  test("a future-year January carry projects too (year-interval view)", () => {
    const budgetData = buildBudgetData();
    const now = new ViewDate("month");
    // Project to January of next year — what the year-interval bar reads.
    const nextYear = now.getEndDate().getFullYear() + 1;
    const januaryNextYear = new ViewDate(
      "month",
      new LocalDate(`${nextYear}-01-15`),
    ).getEndDate();
    expect(budgetData.getRolledOver(budget(), januaryNextYear)).toBeLessThan(0);
    expect(budgetData.getRolledOver(budget(), januaryNextYear)).not.toBe(0);
  });
});

// #634: the future-month projection dropped the CURRENT month's spend-to-date
// S(T). processTransaction banks S(T) into the stored next-month bucket
// (rolled_over(T+1)) but the accrual loop stops at T, so getRolledOver's seed
// (rolled_over(T) alone) omitted it — overstating a future "+ rolled" surplus
// by S(T). getRolledOver now seeds with rolled_over(T) + rolled_over(T+1). The
// #562 projection tests above build from an EMPTY TransactionDictionary, so
// S(T) = 0 and the defect is invisible — these use a current-month spend.
describe("BudgetData.getRolledOver future projection subtracts current-month spend (#634)", () => {
  const OLD_START = "2022-06-01";
  const SPEND = 20;

  const makeCurrentMonthSpend = (): TransactionDictionary => {
    const dict = new TransactionDictionary();
    const t = new Transaction({
      transaction_id: "txn-current",
      account_id: "acc-1",
      name: "Coffee",
      merchant_name: "Cafe",
      amount: SPEND,
      date: new ViewDate("month").getStartDate().toISOString().slice(0, 10),
      pending: false,
      label: { budget_id: "bud-1", category_id: null },
    } as never);
    dict.set(t.transaction_id, t);
    return dict;
  };

  const buildBudgetData = (transactions: TransactionDictionary) => {
    const { budgetData } = getBudgetData(
      transactions,
      emptySplits(),
      makeAccount(),
      makeBudget(OLD_START),
      emptySections(),
      emptyCategories(),
      new TransferDictionary(),
      false, // warm / steady state
    );
    return budgetData;
  };

  const budget = () => makeBudget(OLD_START).get("bud-1")!;

  test("current-month spend is banked into the stored next-month bucket", () => {
    const budgetData = buildBudgetData(makeCurrentMonthSpend());
    const oneAhead = new ViewDate("month").next().getEndDate();
    expect(budgetData.get("bud-1", oneAhead).rolled_over_amount).toBeCloseTo(SPEND, 6);
  });

  test("next-month projection = carry(T) + S(T) - C(T), not carry(T) - C(T)", () => {
    const withSpend = buildBudgetData(makeCurrentMonthSpend());
    const now = new ViewDate("month").getEndDate();
    const oneAhead = new ViewDate("month").next().getEndDate();

    const carryIntoCurrent = withSpend.get("bud-1", now).rolled_over_amount;
    const projected = withSpend.getRolledOver(budget(), oneAhead);

    // Authoritative recurrence: rolled_over(T+1) = rolled_over(T) + S(T) - C(T).
    expect(projected).toBeCloseTo(carryIntoCurrent + SPEND - MONTHLY_CAPACITY, 6);
  });

  test("the spend closes the gap vs an empty month by exactly S(T)", () => {
    const empty = buildBudgetData(new TransactionDictionary());
    const withSpend = buildBudgetData(makeCurrentMonthSpend());
    const oneAhead = new ViewDate("month").next().getEndDate();

    const projectedEmpty = empty.getRolledOver(budget(), oneAhead);
    const projectedSpend = withSpend.getRolledOver(budget(), oneAhead);

    // rolled_over is stored negative (renders "+"). Spending S(T) makes the
    // surplus exactly S(T) SMALLER — less negative than the empty-month case.
    expect(projectedSpend - projectedEmpty).toBeCloseTo(SPEND, 6);
  });
});

// getSummary is the unified read the bars use: sorted/unsorted + rolled_over
// from one call, so the rollover no longer flows on a separate path in the UI.
// It must agree with the underlying history + getRolledOver it abstracts.
describe("BudgetData.getSummary unified figures (#562)", () => {
  const OLD_START = "2022-06-01";

  const buildBudgetData = () => {
    const { budgetData } = getBudgetData(
      new TransactionDictionary(),
      emptySplits(),
      makeAccount(),
      makeBudget(OLD_START),
      emptySections(),
      emptyCategories(),
      new TransferDictionary(),
      false,
    );
    return budgetData;
  };

  const budget = () => makeBudget(OLD_START).get("bud-1")!;

  test("month view returns sorted/unsorted from history and rolled_over from the projection", () => {
    const budgetData = buildBudgetData();
    const viewDate = new ViewDate("month");
    const date = viewDate.getEndDate();
    const stored = budgetData.get("bud-1", date);

    const view = budgetData.getSummary(budget(), viewDate);
    expect(view.sorted_amount).toBe(stored.sorted_amount);
    expect(view.unsorted_amount).toBe(stored.unsorted_amount);
    expect(view.rolled_over_amount).toBe(budgetData.getRolledOver(budget(), date));
  });

  test("future month view projects the rollover (matches getRolledOver)", () => {
    const budgetData = buildBudgetData();
    const viewDate = new ViewDate("month").next(2);
    const view = budgetData.getSummary(budget(), viewDate);
    expect(view.rolled_over_amount).toBe(
      budgetData.getRolledOver(budget(), viewDate.getEndDate()),
    );
    expect(view.rolled_over_amount).not.toBe(0);
  });

  test("year view sums sorted/unsorted and reads the rollover at January", () => {
    const budgetData = buildBudgetData();
    const nextYear = new ViewDate("month").getEndDate().getFullYear() + 1;
    const yearView = new ViewDate("year", new LocalDate(`${nextYear}-07-15`));
    const aggregate = budgetData.get("bud-1").aggregateYear(nextYear);
    const januaryEnd = new ViewDate(
      "month",
      new LocalDate(`${nextYear}-01-15`),
    ).getEndDate();

    const view = budgetData.getSummary(budget(), yearView);
    expect(view.sorted_amount).toBe(aggregate.sorted_amount);
    expect(view.unsorted_amount).toBe(aggregate.unsorted_amount);
    expect(view.rolled_over_amount).toBe(budgetData.getRolledOver(budget(), januaryEnd));
  });

  test("a non-rollover budget-like reports rolled_over_amount === 0", () => {
    const budgetData = buildBudgetData();
    const notRolling = new Budget({
      budget_id: "bud-1",
      user_id: "u1",
      name: "Non-Rolling Budget",
      iso_currency_code: "USD",
      capacities: [
        { active_from: null, children: {}, year: MONTHLY_CAPACITY * 12, month: MONTHLY_CAPACITY, week: 0, day: 0 },
      ],
      roll_over: false,
    });
    const view = budgetData.getSummary(notRolling, new ViewDate("month").next(3));
    expect(view.rolled_over_amount).toBe(0);
  });
});
