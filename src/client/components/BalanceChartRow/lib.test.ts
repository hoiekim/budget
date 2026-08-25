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
          message: expect.stringContaining('"Paycheck" is an income budget targeting $3,000 this period'),
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
    expect(assets[0].note?.message).toContain("rolled-over balance, not this period's target");
    expect(assets[0].note?.message).not.toContain("overspent");
  });

  test("an expense budget carried into the asset column keeps the overspend note", () => {
    const overspent = budget("Groceries", 400, true);

    const { assets } = columnsOf([overspent], { [overspent.id]: 120 });

    expect(assets[0].amount).toBe(120);
    expect(assets[0].note).toEqual({
      label: "Overspent budget: Groceries",
      message: expect.stringContaining('You overspent $120 for the budget "Groceries"'),
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
