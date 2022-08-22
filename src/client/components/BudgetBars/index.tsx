import { ChangeEventHandler, useMemo, useState } from "react";
import { Interval } from "server";
import { useAppContext } from "client";
import BudgetBar from "./BudgetBar";
import "./index.css";

const BudgetBars = () => {
  const {
    budgets,
    selectedBudgetId,
    setSelectedBudgetId,
    selectedInterval,
    setSelectedInterval,
  } = useAppContext();
  const [intervalInput, setIntervalInput] = useState<"" | Interval>(selectedInterval);

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
    <div className="BudgetBars">
      <div>
        <select value={selectedBudgetId} onChange={onChangeBudget}>
          <option>Select Budget</option>
          {budgetOptions}
        </select>
        <select
          value={intervalInput}
          onChange={(e) => {
            const value = e.target.value as Interval;
            setIntervalInput(value);
            setSelectedInterval(value);
          }}
        >
          <option value="year">Yearly</option>
          <option value="month">Monthly</option>
          <option value="week">Weekly</option>
          <option value="day">Daily</option>
        </select>
      </div>
      <div className="row-spacer" />
      {selectedBudget && <BudgetBar key={selectedBudgetId} budget={selectedBudget} />}
    </div>
  );
};

export default BudgetBars;
