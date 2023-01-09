import { useCallback } from "react";
import {
  CalculatedProperties,
  useAppContext,
  ViewDate,
  Budgets,
  Sections,
  Categories,
  Transactions,
  Accounts,
} from "client";
import { Budget, Category, Section } from "server";

type BudgetLike = (Budget | Section | Category) & CalculatedProperties;

/**
 * Receives budget-like data objects maps, calculates their transaction amounts
 * and returns the cloned maps with calculated results.
 */
export const calculatorLambda = (
  budgets: Budgets,
  sections: Sections,
  categories: Categories,
  viewDate: ViewDate,
  transactions: Transactions,
  accounts: Accounts
) => {
  const newBudgets = new Map(budgets);
  const newSections = new Map(sections);
  const newCategories = new Map(categories);

  const setBaseAmounts = (e: BudgetLike) => {
    e.sorted_amount = 0;
    e.unsorted_amount = 0;
    if (e.roll_over && e.roll_over_start_date) {
      const rollOverStartDate = new Date(e.roll_over_start_date);
      const span = viewDate.getSpanFrom(rollOverStartDate);
      if (span < 0) {
        e.rolled_over_amount = undefined;
      } else {
        const interval = viewDate.getInterval();
        const capacity = e.capacities[interval];
        e.rolled_over_amount = -span * capacity;
      }
    }
  };

  newBudgets.forEach(setBaseAmounts);
  newSections.forEach(setBaseAmounts);
  newCategories.forEach(setBaseAmounts);

  transactions.forEach(({ authorized_date, date, account_id, label, amount }) => {
    const transactionDate = new Date(authorized_date || date);
    const account = accounts.get(account_id);
    if (!account || account.hide) return;

    const { budget_id, category_id } = label;

    const previousViewDate = viewDate.clone();
    previousViewDate.previous();

    // Calculates unsorted transactions amount for budgets
    if (!category_id) {
      const budgetId = budget_id || account.label.budget_id;
      if (!budgetId) return;

      const parentBudget = newBudgets.get(budgetId);
      if (parentBudget?.unsorted_amount === undefined) return;
      if (viewDate.has(transactionDate)) {
        parentBudget.unsorted_amount += amount;
      } else if (
        parentBudget.roll_over &&
        parentBudget.roll_over_start_date &&
        new Date(parentBudget.roll_over_start_date) <= transactionDate &&
        transactionDate < previousViewDate.getDate() &&
        parentBudget.rolled_over_amount !== undefined
      ) {
        parentBudget.rolled_over_amount += amount;
      }

      return;
    }

    // Calcuates sorted transactions amount for categories
    const parentCategory = newCategories.get(category_id);
    if (parentCategory?.sorted_amount === undefined) return;
    if (viewDate.has(transactionDate)) {
      parentCategory.sorted_amount += amount;
    } else if (
      parentCategory.roll_over &&
      parentCategory.roll_over_start_date &&
      new Date(parentCategory.roll_over_start_date) <= transactionDate &&
      transactionDate < previousViewDate.getDate() &&
      parentCategory.rolled_over_amount !== undefined
    ) {
      parentCategory.rolled_over_amount += amount;
    }

    // Calcuates sorted transactions amount for sections
    const parentSection = newSections.get(parentCategory.section_id);
    if (parentSection?.sorted_amount === undefined) return;
    if (viewDate.has(transactionDate)) {
      parentSection.sorted_amount += amount;
    } else if (
      parentSection.roll_over &&
      parentSection.roll_over_start_date &&
      new Date(parentSection.roll_over_start_date) <= transactionDate &&
      transactionDate < previousViewDate.getDate() &&
      parentSection.rolled_over_amount !== undefined
    ) {
      parentSection.rolled_over_amount += amount;
    }

    // Calcuates sorted transactions amount for budgets
    const parentBudget = newBudgets.get(parentSection.budget_id);
    if (parentBudget?.sorted_amount === undefined) return;
    if (viewDate.has(transactionDate)) {
      parentBudget.sorted_amount += amount;
    } else if (
      parentBudget.roll_over &&
      parentBudget.roll_over_start_date &&
      new Date(parentBudget.roll_over_start_date) <= transactionDate &&
      transactionDate < previousViewDate.getDate() &&
      parentBudget.rolled_over_amount !== undefined
    ) {
      parentBudget.rolled_over_amount += amount;
    }
  });

  return { budgets: newBudgets, sections: newSections, categories: newCategories };
};

export const useCalculator = () => {
  const { viewDate, setBudgets, setSections, setCategories, transactions, accounts } =
    useAppContext();

  const callback = () => {
    setBudgets((oldBudgets) => {
      let newBudgets = oldBudgets;

      setSections((oldSections) => {
        let newSections = oldSections;

        setCategories((oldCategories) => {
          let newCategories = oldCategories;

          const { budgets, sections, categories } = calculatorLambda(
            oldBudgets,
            oldSections,
            oldCategories,
            viewDate,
            transactions,
            accounts
          );

          newBudgets = budgets;
          newSections = sections;
          newCategories = categories;

          return newCategories;
        });

        return newSections;
      });

      return newBudgets;
    });
  };

  return useCallback(callback, [
    viewDate,
    setBudgets,
    setSections,
    setCategories,
    transactions,
    accounts,
  ]);
};
