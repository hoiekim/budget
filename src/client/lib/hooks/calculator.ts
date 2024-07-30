import { useCallback } from "react";
import { useAppContext } from "client";
import {
  AccountDictionary,
  BudgetDictionary,
  CategoryDictionary,
  Data,
  SectionDictionary,
  TransactionDictionary,
  ViewDate,
} from "common";
import { BudgetLike } from "common/models/BudgetLike";

/**
 * Receives budget-like data objects maps, calculates their transaction amounts
 * and returns the cloned maps with calculated results.
 */
export const calculatorLambda = (
  budgets: BudgetDictionary,
  sections: SectionDictionary,
  categories: CategoryDictionary,
  viewDate: ViewDate,
  transactions: TransactionDictionary,
  accounts: AccountDictionary
) => {
  const date = viewDate.getDate();
  const interval = viewDate.getInterval();

  const newBudgets = new BudgetDictionary(budgets);
  const newSections = new SectionDictionary(sections);
  const newCategories = new CategoryDictionary(categories);

  const setBaseAmounts = (e: BudgetLike) => {
    e.child_section_capacity_total = 0;
    e.child_category_capacity_total = 0;
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
    const sectionCapacity = section.getActiveCapacity(date)[interval];
    const budget = newBudgets.get(section.budget_id);
    if (!budget) return;
    budget.child_section_capacity_total += sectionCapacity;
  });

  newCategories.forEach((category) => {
    setBaseAmounts(category);
    const section = newSections.get(category.section_id);
    if (!section) return;
    const categoryCapacity = category.getActiveCapacity(date)[interval];
    section.child_category_capacity_total += categoryCapacity;
    const budget = newBudgets.get(section.budget_id);
    if (!budget) return;
    budget.child_category_capacity_total += categoryCapacity;
  });

  newSections.forEach((section) => {
    const sectionCapacity = section.getActiveCapacity(date)[interval];
    section.is_children_synced = section.child_category_capacity_total === sectionCapacity;
  });

  newBudgets.forEach((budget) => {
    const budgetCapacity = budget.getActiveCapacity(date)[interval];
    const isBudgetSectionSynced = budget.child_section_capacity_total === budgetCapacity;
    const isBudgetCategorySynced = budget.child_category_capacity_total === budgetCapacity;
    budget.is_children_synced = isBudgetSectionSynced && isBudgetCategorySynced;
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
  const { data, setData, viewDate } = useAppContext();
  const { transactions, accounts } = data;

  const callback = () => {
    setData((oldData) => {
      const newData = new Data(oldData);
      const { budgets, sections, categories } = calculatorLambda(
        newData.budgets,
        newData.sections,
        newData.categories,
        viewDate,
        transactions,
        accounts
      );

      newData.budgets = budgets;
      newData.sections = sections;
      newData.categories = categories;

      return newData;
    });
  };

  return useCallback(callback, [viewDate, setData, transactions, accounts]);
};
