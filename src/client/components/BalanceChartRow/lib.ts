import { MAX_FLOAT, numberToCommaString, ViewDate } from "common";
import type { BudgetFamily } from "client/lib/models/BudgetFamily";
import { StackData } from "./Stacks";

/** What a stack in the asset column is, shown on tap. */
export interface StackNote {
  label: string;
  message: string;
}

/** A chart stack that may explain itself. Account stacks carry no note. */
export interface AnnotatedStack extends StackData {
  note?: StackNote;
}

export interface BudgetColumns {
  assets: AnnotatedStack[];
  liabilities: AnnotatedStack[];
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
 * chart's budget picker renders as `Unlimited`.
 *
 * That takes two guards, because capacities are versioned by `active_from` and
 * the rollover carry accrues one capacity per elapsed month: the capacity at
 * the view date can be finite while earlier months contributed a multiple of
 * the sentinel to the carry, and only a guard on the stacked amount sees that.
 *
 * The carry comes from `getSummary` rather than a direct rollover read so the
 * chart reports the same number as the budget's bar and detail page — for a
 * year view those read the carry INTO the year, not out of it.
 */
export const getBudgetColumns = (
  budgets: BudgetFamily[],
  budgetIds: string[],
  getSummary: (budgetLike: BudgetFamily, viewDate: ViewDate) => { rolled_over_amount: number },
  viewDate: ViewDate,
): BudgetColumns => {
  const assets: AnnotatedStack[] = [];
  const liabilities: AnnotatedStack[] = [];

  const date = viewDate.getEndDate();
  const interval = viewDate.getInterval();

  budgets.forEach((b) => {
    if (!budgetIds.includes(b.id)) return;
    const capacity = b.getActiveAmount(date, interval);
    if (Math.abs(capacity) === MAX_FLOAT) return;
    // Rollover projects forward for future views; capacity already does.
    const amount = b.roll_over ? getSummary(b, viewDate).rolled_over_amount : -capacity;
    if (Math.abs(amount) >= MAX_FLOAT) return;
    const stack: AnnotatedStack = { type: "Budget", name: b.name, amount: Math.abs(amount) };
    if (amount > 0) {
      assets.push({ ...stack, note: assetNote(b.name, stack.amount, capacity, b.roll_over) });
    } else {
      liabilities.push(stack);
    }
  });

  return { assets, liabilities };
};
