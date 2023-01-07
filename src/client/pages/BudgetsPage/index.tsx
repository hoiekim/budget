import { useState } from "react";
import { call, useAppContext } from "client";
import { BudgetBar } from "client/components";
import { Budget, NewBudgetGetResponse } from "server";
import "./index.css";

const BudgetsPage = () => {
  const { budgets, setBudgets } = useAppContext();
  const editingState = useState<string | null>(null);

  const budgetBars = Array.from(budgets).map(([budget_id, budget]) => {
    return <BudgetBar key={budget_id} budget={budget} editingState={editingState} />;
  });

  const onClickAddBudget = async () => {
    const { data } = await call.get<NewBudgetGetResponse>("/api/new-budget");
    if (!data) return;

    const { budget_id } = data;

    const newBudget: Budget = {
      budget_id,
      name: "",
      capacities: { year: 0, month: 0, week: 0, day: 0 },
      iso_currency_code: "USD",
      roll_over: false,
    };

    setBudgets((oldBudgets) => {
      const newBudgets = new Map(oldBudgets);
      newBudgets.set(budget_id, newBudget);
      return newBudgets;
    });

    editingState[1](budget_id);
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
