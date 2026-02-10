import { useEffect } from "react";
import { NewBudgetGetResponse } from "server";
import {
  PATH,
  call,
  useAppContext,
  useLocalStorageState,
  Budget,
  BudgetDictionary,
  Data,
} from "client";
import { BudgetBar } from "client/components";
import "./index.css";

export const BudgetsPage = () => {
  const { data, setData, router } = useAppContext();
  const { budgets } = data;
  const [budgetsOrder, setBudgetsOrder] = useLocalStorageState<string[]>("budgetsOrder", []);

  useEffect(() => {
    setBudgetsOrder((oldOrder) => {
      const set = new Set(oldOrder);
      budgets.forEach((_value, key) => set.add(key));
      return Array.from(set.values());
    });
  }, [budgets, setBudgetsOrder]);

  const budgetBars = Array.from(budgets)
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
      const newBudgets = new BudgetDictionary(newData.budgets);
      newBudgets.set(budget_id, newBudget);
      newData.budgets = newBudgets;
      return newData;
    });

    router.go(PATH.BUDGET_CONFIG, { params: new URLSearchParams({ budget_id }) });
  };

  return (
    <div className="BudgetsPage">
      <h2>All Budgets</h2>
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
