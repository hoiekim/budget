// Run with: bun test --preload ./scripts/test-preload.ts lib.test.ts
import { describe, test, expect } from "bun:test";

import { LocalDate, MAX_FLOAT } from "common";
import { getBudgetColumns } from "./lib";
import { Budget, Capacity } from "client";

const DATE = new LocalDate("2026-03-15");

const budget = (name: string, month: number, roll_over = false) =>
  new Budget({ name, roll_over, capacities: [new Capacity({ month })] });

const columnsOf = (
  budgets: Budget[],
  rolledOver: Record<string, number> = {},
) =>
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

  test("an unlimited budget is skipped on the rollover path as well", () => {
    // The rollover carry of an unlimited budget is derived from the same
    // sentinel, so reading it instead of the capacity re-admits the value the
    // guard exists to exclude.
    const unlimited = budget("Transfers", MAX_FLOAT, true);

    const { assets, liabilities } = columnsOf([unlimited], { [unlimited.id]: MAX_FLOAT });

    expect(named(assets)).toEqual([]);
    expect(named(liabilities)).toEqual([]);
  });

  test("an income budget stacks as an asset and is marked as income", () => {
    const income = budget("Paycheck", -3000);

    const { assets } = columnsOf([income]);

    expect(assets).toEqual([
      { type: "Budget", name: "Paycheck", amount: 3000, capacityKind: "income" },
    ]);
  });

  test("an expense budget carried into the asset column is marked as an overspend", () => {
    // Positive rollover means the budget was overspent, which is the case the
    // asset column's explanation was written for.
    const overspent = budget("Groceries", 400, true);

    const { assets } = columnsOf([overspent], { [overspent.id]: 120 });

    expect(assets).toEqual([
      { type: "Budget", name: "Groceries", amount: 120, capacityKind: "expense" },
    ]);
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
