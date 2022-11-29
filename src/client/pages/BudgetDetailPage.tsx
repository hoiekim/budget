import { useAppContext } from "client";
import { BudgetDetail } from "client/components";
import { PATH } from "client/lib";

export interface BudgetDetailPageParams {
  budget_id?: string;
}

const BudgetDetailPage = () => {
  const { budgets, selectedBudgetId, router } = useAppContext();
  const { path, params, transition } = router;
  let budget_id: string;
  if (path === PATH.BUDGET_DETAIL) budget_id = params.get("budget_id") || "";
  else budget_id = transition.incomingParams.get("budget_id") || "";
  const selectedBudget = budgets.get(budget_id);

  return (
    <div className="BudgetDetailPage">
      {selectedBudget && <BudgetDetail key={selectedBudgetId} budget={selectedBudget} />}
    </div>
  );
};

export default BudgetDetailPage;
