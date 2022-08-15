import { Budget, NewBudgetResponse } from "server";
import { call, useAppContext } from "client";
import BudgetComponent from "./BudgetComponent";
import "./index.css";
import { ChangeEventHandler } from "react";

const BudgetsTable = () => {
  const { budgets, setBudgets, selectedBudgetId, setSelectedBudgetId } = useAppContext();

  const onClickAdd = async () => {
    const { data } = await call.get<NewBudgetResponse>("/api/new-budget");
    if (!data) return;

    const { budget_id } = data;
    if (!budget_id) return;

    const newBudget: Budget = {
      budget_id,
      name: "",
      capacity: 0,
      iso_currency_code: "USD",
      interval: "month",
    };

    setBudgets((oldBudgets) => {
      const newBudgets = new Map(oldBudgets);
      newBudgets.set(budget_id, newBudget);
      return newBudgets;
    });

    setSelectedBudgetId(budget_id);
  };

  const budgetOptions = Array.from(budgets.values()).map((e) => {
    return (
      <option key={e.budget_id} value={e.budget_id}>
        {e.name || "Unnamed"}
      </option>
    );
  });

  const onChangeBudget: ChangeEventHandler<HTMLSelectElement> = (e) => {
    setSelectedBudgetId(e.target.value);
  };

  const selectedBudget = budgets.get(selectedBudgetId);

  return (
    <div className="BudgetsTable">
      <div>Budgets:</div>
      <div>
        <button onClick={onClickAdd}>+</button>
        <select value={selectedBudgetId} onChange={onChangeBudget}>
          <option>Select Budget</option>
          {budgetOptions}
        </select>
      </div>
      {selectedBudget && (
        <BudgetComponent key={selectedBudgetId} budget={selectedBudget} />
      )}
    </div>
  );
};

export default BudgetsTable;
