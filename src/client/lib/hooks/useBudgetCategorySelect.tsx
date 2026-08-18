import { useEffect, useMemo, useState } from "react";
import { Account, Category, TransactionLabel, useAppContext } from "client";

export interface BudgetCategorySelect {
  selectedBudgetIdLabel: string;
  setSelectedBudgetIdLabel: (value: string) => void;
  selectedCategoryIdLabel: string;
  setSelectedCategoryIdLabel: (value: string) => void;
  budgetOptions: JSX.Element[];
  categoryOptions: JSX.Element[];
}

/**
 * The budget + category `<select>` machine shared by every per-row label
 * editor — `TransactionRow`, `InvestmentTransactionRow`, `SplitTransactionRow`,
 * and the `TransactionProperties` panel. Each of those carried its own
 * verbatim copy of: the two `selected*IdLabel` states (initialised from the
 * row's own label, falling back to the account's default budget), the
 * `budgetOptions` list, and the section→budget-filtered `categoryOptions` list.
 *
 * Only the genuinely-shared core lives here. The parts that legitimately differ
 * per consumer stay in each component:
 *  - the **persist handlers** (`onChange*`) — endpoint (`/api/transaction` vs
 *    `/api/investment-transaction` vs `/api/split-transaction`), optimistic
 *    dictionary, and confidence convention all diverge;
 *  - the **sync effect** — the list rows re-sync the budget only when empty,
 *    while the reused Properties panel fully resyncs both fields when the
 *    selected transaction changes.
 *
 * `optionKeyPrefix` keeps each consumer's existing React option keys stable
 * (e.g. `transaction_<id>`, `investment_transaction_<id>`).
 */
export const useBudgetCategorySelect = (
  label: TransactionLabel,
  account: Account | undefined,
  optionKeyPrefix: string,
): BudgetCategorySelect => {
  const { data } = useAppContext();
  const { budgets, sections, categories } = data;

  const [selectedBudgetIdLabel, setSelectedBudgetIdLabel] = useState(() => {
    return label.budget_id || account?.label.budget_id || "";
  });
  const [selectedCategoryIdLabel, setSelectedCategoryIdLabel] = useState(() => {
    return label.category_id || "";
  });

  // Keep local <select> state in lockstep with the underlying label the hook
  // was called with. Without these effects the initial `useState` lazy
  // initializers snapshot the label at mount and never re-read — an
  // external update to the transaction (another tab via the SSE
  // fanout, a background sync-plaid write, a suggestion-engine pass)
  // updates the underlying `data.transactions[id].label` but the
  // component's rendered <select> keeps displaying the stale mount-time
  // value until a page refresh remounts the row.
  //
  // React's `useState` does not "watch" its initial-value argument — the
  // lazy initializer is invoked exactly once per mount. Effects are the
  // documented shape for prop-driven derived state (React docs:
  // "You Might Not Need an Effect" > "Adjusting some state when a prop
  // changes"). If the user has typed a not-yet-submitted change into the
  // <select>, an external prop change WILL clobber it — the on-change
  // handlers submit synchronously so the pending window is a few ms; the
  // trade-off matches `TransactionProperties.tsx`'s existing memo-sync
  // shape (`useEffect(() => setMemoValue(label.memo ?? ""), [tx_id, label.memo])`).
  useEffect(() => {
    setSelectedBudgetIdLabel(label.budget_id || account?.label.budget_id || "");
  }, [label.budget_id, account?.label.budget_id]);
  useEffect(() => {
    setSelectedCategoryIdLabel(label.category_id || "");
  }, [label.category_id]);

  const budgetOptions = useMemo(() => {
    const components: JSX.Element[] = [];
    budgets.forEach((e) => {
      if (!e.name.trim()) return;
      components.push(
        <option key={`${optionKeyPrefix}_budget_option_${e.budget_id}`} value={e.budget_id}>
          {e.name}
        </option>,
      );
    });
    return components;
  }, [optionKeyPrefix, budgets]);

  const categoryOptions = useMemo(() => {
    const availableCategories: Category[] = [];
    sections.forEach((section) => {
      const budget_id = label.budget_id || account?.label.budget_id;
      if (section.budget_id !== budget_id) return;
      categories.forEach((category) => {
        if (category.section_id !== section.section_id) return;
        availableCategories.push(category);
      });
    });

    return availableCategories.map((e) => {
      return (
        <option key={`${optionKeyPrefix}_category_option_${e.category_id}`} value={e.category_id}>
          {e.name}
        </option>
      );
    });
  }, [optionKeyPrefix, label.budget_id, account?.label.budget_id, sections, categories]);

  return {
    selectedBudgetIdLabel,
    setSelectedBudgetIdLabel,
    selectedCategoryIdLabel,
    setSelectedCategoryIdLabel,
    budgetOptions,
    categoryOptions,
  };
};
