import { assign, getYearMonthString, isDate, MAX_FLOAT, ViewDate } from "common";
import { TransactionDictionary, Data, SplitTransactionDictionary, SplitTransaction } from "client";

/**
 * Represents transaction <-> split transaction relationship.
 * The parent transaction id is the key and the children split transactions are
 * the value of the data.
 */
export class TransactionFamilies {
  private data = new Map<string, SplitTransactionDictionary>();

  get size() {
    return this.data.size;
  }

  set = (transactionId: string, children: SplitTransactionDictionary) => {
    this.data.set(transactionId, children);
  };

  get = (transactionId: string): SplitTransactionDictionary | undefined => {
    return this.data.get(transactionId);
  };

  add = (transactionId: string, child: SplitTransaction) => {
    if (!this.data.has(transactionId)) {
      this.data.set(transactionId, new SplitTransactionDictionary());
    }
    this.data.get(transactionId)!.set(child.id, child);
  };

  getChildrenAmountTotal = (transactionId: string) => {
    let total = 0;
    this.get(transactionId)?.forEach(({ amount }) => {
      total += amount;
    });
    return total;
  };

  forEach = this.data.forEach;
}

interface GetBudgetDataResult {
  transactionFamilies: TransactionFamilies;
  budgetData: BudgetData;
}

export const getBudgetData = (data: Data): GetBudgetDataResult => {
  const { transactions, splitTransactions, accounts, budgets, sections, categories } = data;

  const budgetData = new BudgetData();

  const mergedTransactions = new TransactionDictionary(transactions);
  const transactionFamilies = new TransactionFamilies();

  splitTransactions.forEach((splitTransaction) => {
    const { split_transaction_id, transaction_id, toTransaction } = splitTransaction;
    const transaction = transactions.get(transaction_id);
    if (!transaction) return;
    mergedTransactions.set(split_transaction_id, toTransaction());
    transactionFamilies.add(transaction_id, splitTransaction);
  });

  mergedTransactions.forEach(
    ({ transaction_id, authorized_date, date, account_id, label, amount }) => {
      const transactionDate = new Date(authorized_date || date);
      const account = accounts.get(account_id);
      if (!account || account.hide) return;

      const childrenAmountTotal = transactionFamilies.getChildrenAmountTotal(transaction_id);
      const amountAfterSplit = amount - childrenAmountTotal;

      const { budget_id, category_id } = label;

      // Calculates unsorted transactions amount for budgets
      if (!category_id) {
        const budgetId = budget_id || account.label.budget_id;
        if (!budgetId) return;

        const parentBudget = budgets.get(budgetId);
        if (!parentBudget) return;
        budgetData.add(parentBudget.id, transactionDate, {
          unsorted_amount: amountAfterSplit,
          number_of_unsorted_items: 1,
        });
        if (
          parentBudget.roll_over &&
          parentBudget.roll_over_start_date &&
          new Date(parentBudget.roll_over_start_date) <= transactionDate
        ) {
          const nextMonthDate = new ViewDate("month", transactionDate).next().getEndDate();
          budgetData.add(parentBudget.id, nextMonthDate, {
            rolled_over_amount: amountAfterSplit,
          });
        }

        return;
      }

      // Calcuates sorted transactions amount for categories
      const parentCategory = categories.get(category_id);
      if (!parentCategory) return;
      budgetData.add(parentCategory.id, transactionDate, {
        sorted_amount: amountAfterSplit,
      });
      if (
        parentCategory.roll_over &&
        parentCategory.roll_over_start_date &&
        new Date(parentCategory.roll_over_start_date) <= transactionDate
      ) {
        const nextMonthDate = new ViewDate("month", transactionDate).next().getEndDate();
        budgetData.add(parentCategory.id, nextMonthDate, {
          rolled_over_amount: amountAfterSplit,
        });
      }

      // Calcuates sorted transactions amount for sections
      const parentSection = sections.get(parentCategory.section_id);
      if (!parentSection) return;
      budgetData.add(parentSection.id, transactionDate, {
        sorted_amount: amountAfterSplit,
      });
      if (
        parentSection.roll_over &&
        parentSection.roll_over_start_date &&
        new Date(parentSection.roll_over_start_date) <= transactionDate
      ) {
        const nextMonthDate = new ViewDate("month", transactionDate).next().getEndDate();
        budgetData.add(parentSection.id, nextMonthDate, {
          rolled_over_amount: amountAfterSplit,
        });
      }

      // Calcuates sorted transactions amount for budgets
      const parentBudget = budgets.get(parentSection.budget_id);
      if (!parentBudget) return;
      budgetData.add(parentBudget.id, transactionDate, {
        sorted_amount: amountAfterSplit,
      });
      if (
        parentBudget.roll_over &&
        parentBudget.roll_over_start_date &&
        new Date(parentBudget.roll_over_start_date) <= transactionDate
      ) {
        const nextMonthDate = new ViewDate("month", transactionDate).next().getEndDate();
        budgetData.add(parentBudget.id, nextMonthDate, {
          rolled_over_amount: amountAfterSplit,
        });
      }
    },
  );

  budgetData.forEach((history, budgetLikeId) => {
    const budgetLike =
      budgets.get(budgetLikeId) || sections.get(budgetLikeId) || categories.get(budgetLikeId);
    if (!budgetLike) return;
    const { roll_over, roll_over_start_date, getActiveCapacity } = budgetLike;
    if (!roll_over || !roll_over_start_date) return;
    const startDate = new ViewDate("month", roll_over_start_date).next();
    const endDate = new ViewDate("month");
    while (startDate.getEndDate() <= endDate.getEndDate()) {
      const capacity = getActiveCapacity(startDate.getEndDate());
      const previousSummary = history.get(startDate.clone().previous().getEndDate());
      history.add(startDate.getEndDate(), {
        rolled_over_amount: previousSummary.rolled_over_amount - capacity.month,
      });
      startDate.next();
    }
  });

  return { transactionFamilies, budgetData };
};

export const getCapacityData = (data: Data) => {
  const { budgets, sections, categories } = data;
  const capacityData = new CapacityData();

  sections.forEach((section) => {
    const budget = budgets.get(section.budget_id);
    if (!budget) return;
    section.capacities.forEach((capacity) => {
      const { active_from } = capacity;
      const capacityAmount = capacity.month;
      const isInfinite = Math.abs(capacityAmount) === MAX_FLOAT;
      const budgetCapacity = budget.getActiveCapacity(active_from || new Date(0));
      if (isInfinite) {
        const override = MAX_FLOAT * (capacityAmount > 0 ? 1 : -1);
        capacityData.get(budgetCapacity.id).children_total = override;
      } else {
        capacityData.get(budgetCapacity.id).children_total += capacityAmount;
      }
    });
  });

  categories.forEach((category) => {
    const section = sections.get(category.section_id);
    if (!section) return;
    const budget = budgets.get(section.budget_id);
    if (!budget) return;
    category.capacities.forEach((capacity) => {
      const { active_from } = capacity;
      const capacityAmount = capacity.month;
      const isInfinite = Math.abs(capacityAmount) === MAX_FLOAT;
      const sectionCapacity = section.getActiveCapacity(active_from || new Date(0));
      const budgetCapacity = budget.getActiveCapacity(active_from || new Date(0));
      if (isInfinite) {
        const override = MAX_FLOAT * (capacityAmount > 0 ? 1 : -1);
        capacityData.get(sectionCapacity.id).children_total = override;
        capacityData.get(budgetCapacity.id).grand_children_total = override;
      } else {
        capacityData.get(sectionCapacity.id).children_total += capacityAmount;
        capacityData.get(budgetCapacity.id).grand_children_total += capacityAmount;
      }
    });
  });

  return capacityData;
};

class CapacitySummary {
  children_total = 0;
  grand_children_total = 0;
}

export class CapacityData extends Map<string, CapacitySummary> {
  override get = (id: string) => {
    const existing = super.get(id);
    if (existing) return existing;
    const newData = new CapacitySummary();
    this.set(id, newData);
    return newData;
  };
}

class BudgetSummary {
  sorted_amount = 0;
  unsorted_amount = 0;
  number_of_unsorted_items = 0;
  rolled_over_amount = 0;
}

/**
 * @example
 * {
 *    "2026-01": {
 *      sorted_amount: 100,
 *      unsorted_amount: 10,
 *      number_of_unsorted_items: 2,
 *      rolled_over_amount: 50
 *    },
 *    "2026-02": {
 *      sorted_amount: 150,
 *      unsorted_amount: 9,
 *      number_of_unsorted_items: 1,
 *      rolled_over_amount: 40
 *    }
 * }
 */
type BudgetSummaryByMonth = { [k: string]: BudgetSummary };

/**
 * Helper class to abstract budget history write & read processes.
 */
export class BudgetHistory {
  private data: BudgetSummaryByMonth = {};
  private range?: [Date, Date];

  constructor(data?: BudgetSummaryByMonth) {
    if (data) this.data = data;
  }

  private getKey = (date: Date) => getYearMonthString(date);
  private getDate = (key: string) => new Date(`${key}-15`);

  getData = () => ({ ...this.data });
  getRange = () => this.range && [...this.range];

  get startDate() {
    return this.range && new ViewDate("month", this.range[0]);
  }

  get endDate() {
    return this.range && new ViewDate("month", this.range[1]);
  }

  set = (date: Date, query: Partial<BudgetSummary>) => {
    if (!this.range) this.range = [date, date];
    else if (this.range[1] < date) this.range[1] = date;
    else if (date < this.range[0]) this.range[0] = date;
    const existing = this.get(date);
    assign(existing, query);
  };

  get = (date: Date): BudgetSummary => {
    const key = this.getKey(date);
    if (!this.data[key]) this.data[key] = new BudgetSummary();
    return this.data[key];
  };

  /**
   * Add amount to the specified date's position.
   * If amount doesn't exist in the position, assume it was 0.
   */
  add = (date: Date, query: Partial<BudgetSummary>) => {
    const existing = this.get(date) || 0;
    const addedQuery = { ...query };
    Object.entries(query).forEach(([key, value]) => {
      const existingAmount = existing[key as keyof BudgetSummary] || 0;
      addedQuery[key as keyof BudgetSummary] = existingAmount + value;
    });
    this.set(date, addedQuery);
  };

  /**
   * Returns an array of budget history.
   * Values are 0-indexed where 0 is the month of the given `viewDate`,
   * 1 is the previous month, and so on.
   */
  toArray = (viewDate: ViewDate) => {
    const result: BudgetSummary[] = [];
    Object.entries(this.data).forEach(([key, value]) => {
      const date = this.getDate(key);
      if (!isDate(date)) return;
      const span = viewDate.getSpanFrom(date);
      if (span >= 0) result[span] = value;
    });
    return result;
  };
}

export class BudgetData {
  private data = new Map<string, BudgetHistory>();

  get size() {
    return this.data.size;
  }

  set(budgetLikeId: string, date: Date, budgetSummary: Partial<BudgetSummary>) {
    if (!this.data.has(budgetLikeId)) this.data.set(budgetLikeId, new BudgetHistory());
    const accountData = this.data.get(budgetLikeId)!;
    accountData.set(date!, budgetSummary!);
  }

  get(budgetLikeId: string): BudgetHistory;
  get(budgetLikeId: string, date: Date): BudgetSummary;
  get(budgetLikeId: string, date?: Date) {
    if (!this.data.has(budgetLikeId)) this.data.set(budgetLikeId, new BudgetHistory());
    const accountData = this.data.get(budgetLikeId)!;
    if (date === undefined) return accountData;
    return accountData.get(date);
  }

  add = (budgetLikeId: string, date: Date, budgetSummary: Partial<BudgetSummary>) => {
    this.get(budgetLikeId).add(date, budgetSummary);
  };

  forEach = (cb: (history: BudgetHistory, id: string) => void) => this.data.forEach(cb);
}
