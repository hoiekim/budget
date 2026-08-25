// Run with: bun test --preload ./scripts/test-preload.ts lib.test.ts
import { describe, test, expect } from "bun:test";

import { LocalDate, MAX_FLOAT } from "common";
import { getBudgetColumns } from "./lib";
import { Budget, Capacity } from "client";

const DATE = new LocalDate("2026-03-15");

const budget = (name: string, month: number, roll_over = false) =>
  new Budget({ name, roll_over, capacities: [new Capacity({ month })] });

const columnsOf = (budgets: Budget[], rolledOver: Record<string, number> = {}) =>
  getBudgetColumns(
    budgets,
    budgets.map((b) => b.id),
    (b) => rolledOver[b.id] ?? 0,
    DATE,
    "month",
  );

const named = (stacks: { name: string }[]) => stacks.map((s) => s.name);

// The trailing clause is the whole reason the row is tappable — it explains why
// an amount nobody deposited is stacked with the deposits. Asserting a prefix
// lets it be deleted silently, so every message is pinned in full.
const STACKED_WITH_DEPOSITS =
  "We're displaying it stacked together with the deposit amounts because it's the amount that would have been in the depositories.";

describe("getBudgetColumns — capacity shapes the picker already classifies", () => {
  test("an unlimited budget contributes no stack to either column", () => {
    const unlimited = budget("Transfers", MAX_FLOAT);
    const expense = budget("Groceries", 400);

    const { assets, liabilities } = columnsOf([unlimited, expense]);

    expect(named(assets)).toEqual([]);
    expect(named(liabilities)).toEqual(["Groceries"]);
    expect(liabilities[0].amount).toBe(400);
  });

  test("a negative-infinite capacity is unlimited too, not a giant income target", () => {
    // `Capacity.getActiveAmount` returns -MAX_FLOAT for an unlimited budget
    // whose sign is income; matching on the positive sentinel alone would put
    // 3.4e38 in the asset column.
    const { assets, liabilities } = columnsOf([budget("Unlimited income", -MAX_FLOAT)]);

    expect(named(assets)).toEqual([]);
    expect(named(liabilities)).toEqual([]);
  });

  test("an unlimited rollover budget is skipped on its carry, which is a MULTIPLE of the sentinel", () => {
    // The accrual loop subtracts one active capacity per elapsed month with no
    // sentinel guard, so an unlimited budget six months into its rollover
    // window carries -6 x MAX_FLOAT. A guard placed on the stacked amount
    // instead of the capacity compares against the bare sentinel and lets that
    // through — which is the reported symptom, at six times the magnitude.
    const unlimited = budget("Transfers", MAX_FLOAT, true);

    const { assets, liabilities } = columnsOf([unlimited], {
      [unlimited.id]: -6 * MAX_FLOAT,
    });

    expect(named(assets)).toEqual([]);
    expect(named(liabilities)).toEqual([]);
  });

  test("a non-rollover income budget stacks as an asset and its note names the period target", () => {
    const income = budget("Paycheck", -3000);

    const { assets } = columnsOf([income]);

    expect(assets).toEqual([
      {
        type: "Budget",
        name: "Paycheck",
        amount: 3000,
        note: {
          label: "Income budget: Paycheck",
          message: `"Paycheck" is an income budget targeting $3,000 this period. ${STACKED_WITH_DEPOSITS}`,
        },
      },
    ]);
    expect(assets[0].note?.message).not.toContain("overspent");
  });

  test("a rollover income budget's note names its carry, not a target it does not equal", () => {
    // The stacked amount here is six months of accrued carry, so copy that
    // calls it "this period's target" misreports it by 6x — the same
    // wrong-explanation class as the overspend copy on an income budget.
    const income = budget("Paycheck", -3000, true);

    const { assets } = columnsOf([income], { [income.id]: 18000 });

    expect(assets[0].amount).toBe(18000);
    expect(assets[0].note?.label).toBe("Income budget: Paycheck");
    expect(assets[0].note?.message).toBe(
      `"Paycheck" is an income budget. The $18,000 shown is its rolled-over balance, not this period's target. ${STACKED_WITH_DEPOSITS}`,
    );
    expect(assets[0].note?.message).not.toContain("overspent");
  });

  test("an expense budget carried into the asset column keeps the overspend note", () => {
    const overspent = budget("Groceries", 400, true);

    const { assets } = columnsOf([overspent], { [overspent.id]: 120 });

    expect(assets[0].amount).toBe(120);
    expect(assets[0].note).toEqual({
      label: "Overspent budget: Groceries",
      message: `You overspent $120 for the budget "Groceries". ${STACKED_WITH_DEPOSITS}`,
    });
  });

  test("a zero-capacity budget that carries a balance is overspent, not income", () => {
    // A budget with no capacity that still has spending against it rolls a
    // positive balance forward. Only a NEGATIVE capacity is income, so the
    // boundary belongs at zero rather than above it.
    const zeroCapacity = budget("Uncapped spending", 0, true);

    const { assets } = columnsOf([zeroCapacity], { [zeroCapacity.id]: 75 });

    expect(assets[0].note?.label).toBe("Overspent budget: Uncapped spending");
  });

  test("a liability stack carries no note, so its row stays non-interactive", () => {
    const { liabilities } = columnsOf([budget("Groceries", 400)]);

    expect(liabilities[0].note).toBeUndefined();
  });

  test("reads the capacity for the caller's interval, not always the month's", () => {
    // A year view stacks twelve months of capacity. Hardcoding "month" would
    // under-report every budget on the chart by a factor of twelve, and the
    // unlimited guard has to hold on the yearly amount too.
    const expense = budget("Groceries", 400);
    const unlimited = budget("Transfers", MAX_FLOAT);

    const yearly = getBudgetColumns(
      [expense, unlimited],
      [expense.id, unlimited.id],
      () => 0,
      DATE,
      "year",
    );

    expect(yearly.liabilities.map((s) => [s.name, s.amount])).toEqual([["Groceries", 4800]]);
    expect(yearly.assets).toEqual([]);
  });

  test("reads the capacity active at the caller's date, not the newest one", () => {
    // Capacities supersede each other by `active_from`, so a chart on a past
    // month has to stack what the budget was then. Ignoring the date reports
    // the current capacity for every period the chart draws.
    const raised = new Budget({
      name: "Groceries",
      capacities: [
        new Capacity({ month: 400 }),
        new Capacity({ month: 900, active_from: new LocalDate("2026-06-01") }),
      ],
    });

    const before = getBudgetColumns([raised], [raised.id], () => 0, DATE, "month");
    const after = getBudgetColumns(
      [raised],
      [raised.id],
      () => 0,
      new LocalDate("2026-07-15"),
      "month",
    );

    expect(before.liabilities[0].amount).toBe(400);
    expect(after.liabilities[0].amount).toBe(900);
  });

  test("an unselected budget is ignored whatever its capacity", () => {
    const selected = budget("Groceries", 400);
    const unselected = budget("Rent", 2000);

    const { liabilities } = getBudgetColumns(
      [selected, unselected],
      [selected.id],
      () => 0,
      DATE,
      "month",
    );

    expect(named(liabilities)).toEqual(["Groceries"]);
  });
});
