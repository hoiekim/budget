import { NewBudgetResponse } from "server";
import { call, useAppContext } from "client";
import BudgetComponent from "./BudgetComponent";
import "./index.css";

const BudgetsTable = () => {
  const { budgets, setBudgets } = useAppContext();

  const onClickAdd = async () => {
    const { data } = await call.get<NewBudgetResponse>("/api/new-budget");

    setBudgets((oldBudgets) => {
      const newBudgets = new Map(oldBudgets);
      const budget_id = data?.budget_id;
      if (budget_id)
        newBudgets.set(budget_id, {
          budget_id,
          name: "",
          capacity: 0,
          iso_currency_code: "USD",
          interval: "month",
        });
      return newBudgets;
    });
  };

  const budgetComponents = Array.from(budgets.values()).map((e, i) => {
    return <BudgetComponent key={i} budget={e} />;
  });
  return (
    <div className="BudgetsTable">
      <div>
        <span>Budgets:</span>
      </div>
      <div>
        <button onClick={onClickAdd}>+</button>
      </div>
      <div>{budgetComponents}</div>
    </div>
  );
};

export default BudgetsTable;
