import { useAppContext } from "client";
import { BudgetDetail } from "client/components";

export interface BudgetDetailPageParams {
  budget_id?: string;
}

const BudgetDetailPage = () => {
  const { budgets, selectedBudgetId, router } = useAppContext();
  const { params } = router;
  const budget_id = params.get("budget_id") || "";
  const selectedBudget = budgets.get(budget_id);

  return (
    <div className="BudgetDetailPage">
      {selectedBudget && <BudgetDetail key={selectedBudgetId} budget={selectedBudget} />}
    </div>
  );
};

export default BudgetDetailPage;
