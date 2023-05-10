import { Dispatch, SetStateAction } from "react";
import { Budget } from "common";
import { useAppContext, PATH, BudgetDetailPageParams } from "client";
import { LabeledBar } from "client/components";

const { BUDGET_DETAIL } = PATH;

interface Props {
  budget: Budget;
  onSetOrder?: Dispatch<SetStateAction<string[]>>;
}

const BudgetBar = ({ budget, onSetOrder }: Props) => {
  const { router } = useAppContext();
  const { path, go } = router;

  const { budget_id, iso_currency_code } = budget;

  const onClickInfo = () => {
    if (path === BUDGET_DETAIL) return;
    const paramObj: BudgetDetailPageParams = { budget_id };
    const params = new URLSearchParams(paramObj);
    go(BUDGET_DETAIL, { params });
  };

  return (
    <LabeledBar
      key={budget_id}
      dataId={budget_id}
      data={budget}
      iso_currency_code={iso_currency_code}
      onClickInfo={onClickInfo}
      onSetOrder={onSetOrder}
    />
  );
};

export default BudgetBar;
