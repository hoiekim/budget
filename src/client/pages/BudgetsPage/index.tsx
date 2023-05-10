import { useEffect } from "react";
import { PATH, call, useAppContext, useLocalStorage } from "client";
import { BudgetBar } from "client/components";
import { NewBudgetGetResponse } from "server";
import { Budget, getIndex } from "common";
import "./index.css";

const BudgetsPage = () => {
  const { budgets, setBudgets, router } = useAppContext();
  const [budgetsOrder, setBudgetsOrder] = useLocalStorage<string[]>("budgetsOrder", []);

  useEffect(() => {
    setBudgetsOrder((oldOrder) => {
      const set = new Set(oldOrder);
      budgets.forEach((_value, key) => set.add(key));
      return Array.from(set.values());
    });
  }, [budgets, setBudgetsOrder]);

  const budgetBars = Array.from(budgets)
    .sort(([a], [b]) => {
      const indexA = getIndex(a, budgetsOrder);
      const indexB = getIndex(b, budgetsOrder);
      if (indexA === undefined || indexB === undefined) return 0;
      return indexA - indexB;
    })
    .map(([budget_id, budget]) => {
      return <BudgetBar key={budget_id} budget={budget} onSetOrder={setBudgetsOrder} />;
    });

  const onClickAddBudget = async () => {
    const { data } = await call.get<NewBudgetGetResponse>("/api/new-budget");
    if (!data) return;

    const { budget_id } = data;

    const newBudget = new Budget({ budget_id });

    setBudgets((oldBudgets) => {
      const newBudgets = new Map(oldBudgets);
      newBudgets.set(budget_id, newBudget);
      return newBudgets;
    });

    router.go(PATH.BUDGET_CONFIG, { params: new URLSearchParams({ id: budget_id }) });
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

export default BudgetsPage;
