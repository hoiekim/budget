import { useEffect } from "react";
import { NewBudgetGetResponse } from "server";
import {
  PATH,
  ScreenType,
  call,
  useAppContext,
  useLocalStorageState,
  useMultiSelectQueryFilter,
  Budget,
  BudgetDictionary,
  Data,
  indexedDb,
} from "client";
import { BudgetBar, FilterOption, PageFilterTitle } from "client/components";
import "./index.css";

/**
 * Six discrete filter tokens across three binary dimensions of a budget:
 *
 * - `expense` vs `income` — sign of the active capacity (`isIncome`).
 * - `limited` vs `unlimited` — bounded vs infinite active capacity
 *   (`isInfinite`).
 * - `rolling-over` vs `non-rolling-over` — the budget's `roll_over` flag.
 *
 * Multi-select semantics are OR-within-dimension, AND-across-dimensions:
 * picking `expense` + `limited` narrows to budgets that are both, but
 * picking `expense` + `income` collapses that dimension (both sides of
 * the binary pair are allowed, i.e. the dimension is unfiltered).
 */
type BudgetFilterToken =
  | "expense"
  | "income"
  | "limited"
  | "unlimited"
  | "rolling-over"
  | "non-rolling-over";

const BUDGET_FILTER_LABELS: Record<BudgetFilterToken, string> = {
  expense: "Expense",
  income: "Income",
  limited: "Limited",
  unlimited: "Unlimited",
  "rolling-over": "Rolling Over",
  "non-rolling-over": "Non-Rolling Over",
};

const titleForSelection = (tokens: BudgetFilterToken[]): string => {
  if (tokens.length === 0) return "All Budgets";
  if (tokens.length === 1) return BUDGET_FILTER_LABELS[tokens[0]];
  return tokens.map((t) => BUDGET_FILTER_LABELS[t]).join(", ");
};

export const BudgetsPage = () => {
  const { data, setData, router, viewDate, screenType } = useAppContext();
  const { budgets } = data;
  const { path, params, transition } = router;
  const [budgetsOrder, setBudgetsOrder] = useLocalStorageState<string[]>("budgetsOrder", []);

  const activeParams =
    path === PATH.BUDGETS || screenType !== ScreenType.Narrow ? params : transition.incomingParams;

  const {
    selected: selectedFilters,
    toggle,
    clearAll,
    options,
  } = useMultiSelectQueryFilter<BudgetFilterToken>("budget_filter", BUDGET_FILTER_LABELS, {
    activeParams,
  });

  useEffect(() => {
    setBudgetsOrder((oldOrder) => {
      const set = new Set(oldOrder);
      budgets.forEach((_value, key) => set.add(key));
      return Array.from(set.values());
    });
  }, [budgets, setBudgetsOrder]);

  const filterSet = new Set(selectedFilters);
  const filterHasIncome = filterSet.has("income");
  const filterHasExpense = filterSet.has("expense");
  const filterHasLimited = filterSet.has("limited");
  const filterHasUnlimited = filterSet.has("unlimited");
  const filterHasRolling = filterSet.has("rolling-over");
  const filterHasNonRolling = filterSet.has("non-rolling-over");
  const date = viewDate.getEndDate();

  const budgetBars = Array.from(budgets)
    .filter(([, budget]) => {
      // For each dimension: if the user picked only one side of the
      // binary pair, filter to that side; if they picked both or
      // neither, the dimension is unfiltered.
      const capacity = budget.getActiveCapacity(date);
      const isIncome = capacity?.isIncome ?? false;
      const isInfinite = capacity?.isInfinite ?? false;
      const isRollingOver = budget.roll_over;

      if (filterHasIncome !== filterHasExpense) {
        if (filterHasIncome && !isIncome) return false;
        if (filterHasExpense && isIncome) return false;
      }
      if (filterHasLimited !== filterHasUnlimited) {
        if (filterHasLimited && isInfinite) return false;
        if (filterHasUnlimited && !isInfinite) return false;
      }
      if (filterHasRolling !== filterHasNonRolling) {
        if (filterHasRolling && !isRollingOver) return false;
        if (filterHasNonRolling && isRollingOver) return false;
      }
      return true;
    })
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

  return (
    <div className="BudgetsPage">
      <PageFilterTitle
        label={titleForSelection(selectedFilters)}
        dropdownLabel={<>Select&nbsp;budget&nbsp;filters</>}
        closeAriaLabel="Close budget filter selector"
      >
        <FilterOption checked={selectedFilters.length === 0} onSelect={clearAll}>
          All&nbsp;Budgets
        </FilterOption>
        {options.map(({ value, label }) => (
          <FilterOption
            key={value}
            checked={selectedFilters.includes(value)}
            onSelect={() => toggle(value)}
          >
            {label}
          </FilterOption>
        ))}
      </PageFilterTitle>
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
