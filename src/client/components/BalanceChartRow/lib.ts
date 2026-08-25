import { Interval, MAX_FLOAT, numberToCommaString } from "common";
import type { BudgetFamily } from "client/lib/models/BudgetFamily";
import { StackData } from "./Stacks";

/** What a budget stack in the asset column is, shown on tap. */
export interface StackNote {
  label: string;
  message: string;
}

export interface BudgetStack extends StackData {
  note?: StackNote;
}

export interface BudgetColumns {
  assets: BudgetStack[];
  liabilities: BudgetStack[];
}

const STACKED_WITH_DEPOSITS =
  "We're displaying it stacked together with the deposit amounts because it's the amount that would have been in the depositories.";

const assetNote = (
  name: string,
  amount: number,
  capacity: number,
  rollsOver: boolean,
): StackNote => {
  const amountString = numberToCommaString(amount, 0);
  if (capacity >= 0) {
    return {
      label: `Overspent budget: ${name}`,
      message: `You overspent $${amountString} for the budget "${name}". ${STACKED_WITH_DEPOSITS}`,
    };
  }
  return {
    label: `Income budget: ${name}`,
    message: rollsOver
      ? `"${name}" is an income budget. The $${amountString} shown is its rolled-over balance, not this period's target. ${STACKED_WITH_DEPOSITS}`
      : `"${name}" is an income budget targeting $${amountString} this period. ${STACKED_WITH_DEPOSITS}`,
  };
};

/**
 * Splits the selected budgets into the chart's asset and liability columns.
 *
 * A budget's capacity is a claim on the depositories, so it stacks opposite its
 * sign: an expense capacity is a liability, while an income target and the
 * carry of an overspent budget are assets. An unlimited capacity reserves no
 * finite amount, so it has nothing to stack — the same classification the
 * chart's budget picker renders as `Unlimited`. The guard reads the capacity
 * rather than the stacked amount because the rollover carry accrues one
 * capacity per elapsed month, so an unlimited budget's carry is a multiple of
 * the sentinel rather than the sentinel itself.
 */
export const getBudgetColumns = (
  budgets: BudgetFamily[],
  budgetIds: string[],
  getRolledOver: (budgetLike: BudgetFamily, date: Date) => number,
  date: Date,
  interval: Interval,
): BudgetColumns => {
  const assets: BudgetStack[] = [];
  const liabilities: BudgetStack[] = [];

  budgets.forEach((b) => {
    if (!budgetIds.includes(b.id)) return;
    const capacity = b.getActiveAmount(date, interval);
    if (Math.abs(capacity) === MAX_FLOAT) return;
    // Rollover projects forward for future views; capacity already does.
    const amount = b.roll_over ? getRolledOver(b, date) : -capacity;
    const stack: BudgetStack = { type: "Budget", name: b.name, amount: Math.abs(amount) };
    if (amount > 0) {
      assets.push({ ...stack, note: assetNote(b.name, stack.amount, capacity, b.roll_over) });
    } else {
      liabilities.push(stack);
    }
  });

  return { assets, liabilities };
};
