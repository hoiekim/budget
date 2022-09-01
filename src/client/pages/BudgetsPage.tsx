import { useMemo } from "react";
import { useAppContext } from "client";
import { BudgetBar } from "client/components";

const BudgetsPage = () => {
  const { budgets, selectedBudgetId } = useAppContext();

  const selectedBudget = useMemo(
    () => budgets.get(selectedBudgetId),
    [budgets, selectedBudgetId]
  );

  return (
    <div className="BudgetsPage">
      {selectedBudget && <BudgetBar key={selectedBudgetId} budget={selectedBudget} />}
    </div>
  );
};

export default BudgetsPage;
