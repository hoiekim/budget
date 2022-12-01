import { Budget, NewBudgetGetResponse } from "server";
import { call, useAppContext } from "client";
import { BudgetBar } from "client/components";
import "./index.css";

const BudgetsTable = () => {
  const { budgets, setBudgets } = useAppContext();
  const budgetBars = Array.from(budgets).map(([budget_id, budget]) => {
    return <BudgetBar key={budget_id} budget={budget} />;
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
    };
    setBudgets((oldBudgets) => {
      const newBudgets = new Map(oldBudgets);
      newBudgets.set(budget_id, newBudget);
      return newBudgets;
    });
  };

  return (
    <div className="BudgetsTable BudgetBar">
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
  );
};

export default BudgetsTable;
