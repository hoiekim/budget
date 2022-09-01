import { useMemo } from "react";
import { Budget, NewBudgetGetResponse } from "server";
import { call, useAppContext } from "client";
import BudgetComponent from "./BudgetComponent";
import "./index.css";

const BudgetsTable = () => {
  const { budgets, setBudgets, selectedBudgetId, setSelectedBudgetId } = useAppContext();

  const onClickAdd = async () => {
    const { data } = await call.get<NewBudgetGetResponse>("/api/new-budget");
    if (!data) return;

    const { budget_id } = data;

    const newBudget: Budget = {
      budget_id,
      name: "",
      capacities: { year: 0, month: 0, week: 0, day: 0 },
      iso_currency_code: "USD",
    };

    setBudgets((oldBudgets) => {
      const newBudgets = new Map(oldBudgets);
      newBudgets.set(budget_id, newBudget);
      return newBudgets;
    });

    setSelectedBudgetId(budget_id);
  };

  const selectedBudget = useMemo(
    () => budgets.get(selectedBudgetId),
    [budgets, selectedBudgetId]
  );

  return (
    <div className="BudgetsTable">
      <h2>Budgets</h2>
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
