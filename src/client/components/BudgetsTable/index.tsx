import { ChangeEventHandler, useMemo } from "react";
import { Budget, Interval, NewBudgetGetResponse } from "server";
import { call, useAppContext } from "client";
import BudgetComponent from "./BudgetComponent";
import "./index.css";

const BudgetsTable = () => {
  const {
    budgets,
    setBudgets,
    selectedBudgetId,
    setSelectedBudgetId,
    selectedInterval,
    setSelectedInterval,
  } = useAppContext();

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

  const budgetOptions = useMemo(() => {
    const components: JSX.Element[] = [];
    budgets.forEach((e) => {
      const conponent = (
        <option key={e.budget_id} value={e.budget_id}>
          {e.name || "Unnamed"}
        </option>
      );
      components.push(conponent);
    });
    return components;
  }, [budgets]);

  const onChangeBudget: ChangeEventHandler<HTMLSelectElement> = (e) => {
    setSelectedBudgetId(e.target.value);
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
        <select value={selectedBudgetId} onChange={onChangeBudget}>
          <option>Select Budget</option>
          {budgetOptions}
        </select>
        <select
          value={selectedInterval}
          onChange={(e) => {
            const value = e.target.value as Interval;
            setSelectedInterval(value);
          }}
        >
          <option value="year">Yearly</option>
          <option value="month">Monthly</option>
          <option value="week">Weekly</option>
          <option value="day">Daily</option>
        </select>
      </div>
      {selectedBudget && (
        <BudgetComponent key={selectedBudgetId} budget={selectedBudget} />
      )}
    </div>
  );
};

export default BudgetsTable;
