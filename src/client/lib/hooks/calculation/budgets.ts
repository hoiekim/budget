import { MAX_FLOAT, ViewDate } from "common";
import { TransactionDictionary, Data, TransactionFamilies, BudgetData, CapacityData } from "client";

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
