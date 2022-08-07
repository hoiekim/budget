import { Budget, NewBudgetResponse } from "server";
import { call, useAppContext, useLocalStorage } from "client";
import BudgetComponent from "./BudgetComponent";
import "./index.css";
import { ChangeEventHandler } from "react";

const BudgetsTable = () => {
  const { budgets, setBudgets } = useAppContext();
  const [selectedBudgetId, setSelectedBudgetId] = useLocalStorage<string>(
    "selectedBudgetId",
    ""
  );

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

  const budgetOptions = Array.from(budgets.values()).map((e, i) => {
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
        <select value={selectedBudgetId} onChange={onChangeBudget}>
          <option>Select Budget</option>
          {budgetOptions}
        </select>
      </div>
      <div>
        <button onClick={onClickAdd}>+</button>
      </div>
      {selectedBudget && (
        <BudgetComponent key={selectedBudgetId} budget={selectedBudget} />
      )}
    </div>
  );
};

export default BudgetsTable;
