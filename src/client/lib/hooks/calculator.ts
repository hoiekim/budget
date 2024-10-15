import { useCallback } from "react";
import { useAppContext } from "client";
import {
  BudgetDictionary,
  SectionDictionary,
  CategoryDictionary,
  Data,
  MAX_FLOAT,
  ViewDate,
} from "common";
import { BudgetFamily } from "common/models/BudgetFamily";

/**
 * Receives budget-like data objects maps, calculates their transaction amounts
 * and returns the cloned maps with calculated results.
 */
export const calculatorLambda = (data: Data, viewDate: ViewDate) => {
  const { transactions, accounts, budgets, sections, categories } = data;
  const interval = viewDate.getInterval();

  const newBudgets = new BudgetDictionary(budgets);
  const newSections = new SectionDictionary(sections);
  const newCategories = new CategoryDictionary(categories);

  const setBaseAmounts = (e: BudgetFamily) => {
    e.capacities.forEach((c) => {
      c.children_total = 0;
      c.grand_children_total = 0;
    });
    e.sorted_amount = 0;
    e.unsorted_amount = 0;
    e.number_of_unsorted_items = 0;
    if (!e.roll_over || !e.roll_over_start_date) return;
    const rollDate = e.roll_over_start_date;
    const accumulatedCapacity = e.getAccumulatedCapacity(rollDate, viewDate);
    e.rolled_over_amount = -accumulatedCapacity;
  };

  newBudgets.forEach((budget) => {
    setBaseAmounts(budget);
  });

  newSections.forEach((section) => {
    setBaseAmounts(section);
    const budget = newBudgets.get(section.budget_id);
    if (!budget) return;
    section.capacities.forEach((capacity) => {
      const { active_from } = capacity;
      const capacityAmount = capacity[interval];
      const adding = Math.abs(capacityAmount) === MAX_FLOAT ? 0 : capacityAmount;
      budget.getActiveCapacity(active_from || new Date(0)).children_total += adding;
    });
  });

  newCategories.forEach((category) => {
    setBaseAmounts(category);
    const section = newSections.get(category.section_id);
    if (!section) return;
    category.capacities.forEach((capacity) => {
      const { active_from } = capacity;
      const capacityAmount = capacity[interval];
      const adding = Math.abs(capacityAmount) === MAX_FLOAT ? 0 : capacityAmount;
      const sectionCapacity = section.getActiveCapacity(active_from || new Date(0));
      sectionCapacity.children_total += adding;
      const budget = newBudgets.get(section.budget_id);
      if (!budget) return;
      budget.getActiveCapacity(active_from || new Date(0)).grand_children_total += adding;
    });
  });

  transactions.forEach(({ authorized_date, date, account_id, label, amount }) => {
    const transactionDate = new Date(authorized_date || date);
    const account = accounts.get(account_id);
    if (!account || account.hide) return;

    const { budget_id, category_id } = label;

    // Calculates unsorted transactions amount for budgets
    if (!category_id) {
      const budgetId = budget_id || account.label.budget_id;
      if (!budgetId) return;

      const parentBudget = newBudgets.get(budgetId);
      if (!parentBudget) return;
      if (viewDate.has(transactionDate)) {
        parentBudget.unsorted_amount += amount;
        parentBudget.number_of_unsorted_items++;
      } else if (
        parentBudget.roll_over &&
        parentBudget.roll_over_start_date &&
        new Date(parentBudget.roll_over_start_date) <= transactionDate &&
        transactionDate < viewDate.getDateAsStartDate() &&
        parentBudget.rolled_over_amount !== undefined
      ) {
        parentBudget.rolled_over_amount += amount;
      }

      return;
    }

    // Calcuates sorted transactions amount for categories
    const parentCategory = newCategories.get(category_id);
    if (!parentCategory) return;
    if (viewDate.has(transactionDate)) {
      parentCategory.sorted_amount += amount;
    } else if (
      parentCategory.roll_over &&
      parentCategory.roll_over_start_date &&
      new Date(parentCategory.roll_over_start_date) <= transactionDate &&
      transactionDate < viewDate.getDateAsStartDate() &&
      parentCategory.rolled_over_amount !== undefined
    ) {
      parentCategory.rolled_over_amount += amount;
    }

    // Calcuates sorted transactions amount for sections
    const parentSection = newSections.get(parentCategory.section_id);
    if (!parentSection) return;
    if (viewDate.has(transactionDate)) {
      parentSection.sorted_amount += amount;
    } else if (
      parentSection.roll_over &&
      parentSection.roll_over_start_date &&
      new Date(parentSection.roll_over_start_date) <= transactionDate &&
      transactionDate < viewDate.getDateAsStartDate() &&
      parentSection.rolled_over_amount !== undefined
    ) {
      parentSection.rolled_over_amount += amount;
    }

    // Calcuates sorted transactions amount for budgets
    const parentBudget = newBudgets.get(parentSection.budget_id);
    if (!parentBudget) return;
    if (viewDate.has(transactionDate)) {
      parentBudget.sorted_amount += amount;
    } else if (
      parentBudget.roll_over &&
      parentBudget.roll_over_start_date &&
      new Date(parentBudget.roll_over_start_date) <= transactionDate &&
      transactionDate < viewDate.getDateAsStartDate() &&
      parentBudget.rolled_over_amount !== undefined
    ) {
      parentBudget.rolled_over_amount += amount;
    }
  });

  return { budgets: newBudgets, sections: newSections, categories: newCategories };
};

export const useCalculator = () => {
  const { setData, viewDate } = useAppContext();

  const callback = () => {
    setData((oldData) => {
      const newData = new Data(oldData);
      const { budgets, sections, categories } = calculatorLambda(newData, viewDate);
      newData.budgets = budgets;
      newData.sections = sections;
      newData.categories = categories;
      return newData;
    });
  };

  return useCallback(callback, [viewDate, setData]);
};
