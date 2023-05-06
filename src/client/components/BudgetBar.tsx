import { Dispatch, SetStateAction } from "react";
import { DeepPartial, Budget } from "common";
import { call, useAppContext, PATH, BudgetDetailPageParams } from "client";
import { LabeledBar } from "client/components";

const { BUDGET_DETAIL } = PATH;

interface Props {
  budget: Budget;
  editingState?: [string | null, Dispatch<SetStateAction<string | null>>];
  onSetOrder?: Dispatch<SetStateAction<string[]>>;
}

const BudgetBar = ({ budget, editingState, onSetOrder }: Props) => {
  const { setBudgets, router } = useAppContext();
  const { path, go } = router;

  const { budget_id, name, iso_currency_code } = budget;

  const onClickInfo = () => {
    if (path === BUDGET_DETAIL) return;
    const paramObj: BudgetDetailPageParams = { budget_id };
    const params = new URLSearchParams(paramObj);
    go(BUDGET_DETAIL, { params });
  };

  const onSubmit = async (updatedBudget: DeepPartial<Budget>) => {
    const { status } = await call.post("/api/budget", {
      ...updatedBudget,
      budget_id,
    });
    if (status === "success") {
      setBudgets((oldBudgets) => {
        const newBudgets = new Map(oldBudgets);
        const oldBudget = oldBudgets.get(budget_id);
        const newBudget = { ...oldBudget, ...updatedBudget };
        newBudgets.set(budget_id, newBudget as Budget);
        return newBudgets;
      });
    } else throw new Error(`Failed to update budget: ${budget_id}`);
  };

  const onDelete = async () => {
    if (!window.confirm(`Do you want to delete budget: ${name || "Unnamed"}?`)) return;
    const queryString = "?" + new URLSearchParams({ id: budget_id }).toString();
    const { status } = await call.delete("/api/budget" + queryString);
    if (status === "success") {
      setBudgets((oldBudgets) => {
        const newBudgets = new Map(oldBudgets);
        newBudgets.delete(budget_id);
        return newBudgets;
      });
    }
  };

  return (
    <LabeledBar
      key={budget_id}
      dataId={budget_id}
      data={budget}
      iso_currency_code={iso_currency_code}
      onSubmit={onSubmit}
      onDelete={onDelete}
      onClickInfo={onClickInfo}
      editingState={editingState}
      onSetOrder={onSetOrder}
    />
  );
};

export default BudgetBar;
