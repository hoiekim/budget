import { useEffect, useMemo } from "react";
import { NewBudgetGetResponse } from "server";
import {
  PATH,
  call,
  useAppContext,
  useLocalStorageState,
  useMultiSelectQueryFilter,
  Budget,
  BudgetDictionary,
  Data,
  indexedDb,
} from "client";
import { BudgetBar, FilterOption, PageFilterTitle, PageTitle } from "client/components";
import "./index.css";

const titleForSelection = (codes: string[]): string => {
  if (codes.length === 0) return "All Budgets";
  if (codes.length === 1) return codes[0];
  return codes.join(", ");
};

export const BudgetsPage = () => {
  const { data, setData, router } = useAppContext();
  const { budgets } = data;
  const [budgetsOrder, setBudgetsOrder] = useLocalStorageState<string[]>("budgetsOrder", []);

  // Filter dropdown lists the currencies actually present in the user's
  // budgets. Codes serve as their own display label (USD, EUR, ...) —
  // a UI convention that keeps the dropdown short for common single-
  // currency users and honest about the actual data.
  const currencyLabels = useMemo(() => {
    const codes = new Set<string>();
    budgets.forEach((b) => codes.add(b.iso_currency_code));
    const sorted = Array.from(codes).sort();
    return Object.fromEntries(sorted.map((c) => [c, c])) as Record<string, string>;
  }, [budgets]);

  const {
    selected: selectedCurrencies,
    toggle,
    clearAll,
    options,
  } = useMultiSelectQueryFilter<string>("iso_currency_code", currencyLabels);

  useEffect(() => {
    setBudgetsOrder((oldOrder) => {
      const set = new Set(oldOrder);
      budgets.forEach((_value, key) => set.add(key));
      return Array.from(set.values());
    });
  }, [budgets, setBudgetsOrder]);

  const budgetBars = Array.from(budgets)
    .filter(
      ([, b]) => selectedCurrencies.length === 0 || selectedCurrencies.includes(b.iso_currency_code),
    )
    .sort(([a], [b]) => {
      const indexA = budgetsOrder.indexOf(a);
      const indexB = budgetsOrder.indexOf(b);
      if (indexA === undefined || indexB === undefined) return 0;
      return indexA - indexB;
    })
    .map(([budget_id, budget]) => {
      return (
        <BudgetBar
          key={budget_id}
          budget={budget}
          onSetOrder={setBudgetsOrder}
          hideEditButton={true}
        />
      );
    });

  const onClickAddBudget = async () => {
    const { body } = await call.get<NewBudgetGetResponse>("/api/new-budget");
    if (!body) return;

    const { budget_id } = body;

    setData((oldData) => {
      const newData = new Data(oldData);
      const newBudget = new Budget({ budget_id });
      indexedDb.save(newBudget).catch(console.error);
      const newBudgets = new BudgetDictionary(newData.budgets);
      newBudgets.set(budget_id, newBudget);
      newData.budgets = newBudgets;
      return newData;
    });

    router.go(PATH.BUDGET_CONFIG, { params: new URLSearchParams({ budget_id }) });
  };

  // Only render the filter chrome when the user has budgets in more
  // than one currency — a dropdown with a single option reads as
  // clutter and forces `PageFilterTitle`'s chevron on the header
  // without anything to pick.
  const showFilter = options.length > 1;

  return (
    <div className="BudgetsPage">
      {showFilter ? (
        <PageFilterTitle
          label={titleForSelection(selectedCurrencies)}
          dropdownLabel={<>Select&nbsp;currencies</>}
          closeAriaLabel="Close currency selector"
        >
          <FilterOption checked={selectedCurrencies.length === 0} onSelect={clearAll}>
            All Budgets
          </FilterOption>
          {options.map(({ value, label }) => (
            <FilterOption
              key={value}
              checked={selectedCurrencies.includes(value)}
              onSelect={() => toggle(value)}
            >
              {label}
            </FilterOption>
          ))}
        </PageFilterTitle>
      ) : (
        <PageTitle>All Budgets</PageTitle>
      )}
      <div className="budgetsTable">
        {budgetBars}
        <div className="addButton">
          <button onClick={onClickAddBudget}>+</button>
        </div>
        {!budgetBars.length && (
          <div className="placeholder">
            You don't have any budgets! Click this button to create one.
          </div>
        )}
      </div>
    </div>
  );
};
