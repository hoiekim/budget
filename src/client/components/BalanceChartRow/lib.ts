import { Interval, MAX_FLOAT } from "common";
import type { BudgetFamily } from "client/lib/models/BudgetFamily";
import { StackData } from "./Stacks";

export interface BudgetColumns {
  assets: StackData[];
  liabilities: StackData[];
}

/**
 * Splits the selected budgets into the chart's asset and liability columns.
 *
 * A budget's capacity is a claim on the depositories, so it stacks opposite
 * its sign: an expense capacity is a liability, and the rollover carry of an
 * overspent budget is an asset because that money would otherwise still be in
 * the depositories. An unlimited capacity reserves no finite amount, so it has
 * nothing to stack — the same classification the chart's budget picker renders
 * as `Unlimited`.
 */
export const getBudgetColumns = (
  budgets: BudgetFamily[],
  budgetIds: string[],
  getRolledOver: (budgetLike: BudgetFamily, date: Date) => number,
  date: Date,
  interval: Interval,
): BudgetColumns => {
  const assets: StackData[] = [];
  const liabilities: StackData[] = [];

  budgets.forEach((b) => {
    if (!budgetIds.includes(b.id)) return;
    const capacity = b.getActiveAmount(date, interval);
    if (Math.abs(capacity) === MAX_FLOAT) return;
    // Rollover projects forward for future views; capacity already does.
    const amount = b.roll_over ? getRolledOver(b, date) : -capacity;
    const stack: StackData = {
      type: "Budget",
      name: b.name,
      amount: Math.abs(amount),
      capacityKind: capacity < 0 ? "income" : "expense",
    };
    if (amount > 0) assets.push(stack);
    else liabilities.push(stack);
  });

  return { assets, liabilities };
};
