import { Dispatch, SetStateAction } from "react";
import { Budget } from "common";
import { useAppContext, PATH, BudgetDetailPageParams } from "client";
import { LabeledBar } from "client/components";

const { BUDGET_DETAIL } = PATH;

interface Props {
  budget: Budget;
  onSetOrder?: Dispatch<SetStateAction<string[]>>;
  hideEditButton?: boolean;
}

export const BudgetBar = ({ budget, onSetOrder, hideEditButton }: Props) => {
  const { router } = useAppContext();
  const { path, go } = router;

  const { budget_id, iso_currency_code } = budget;

  const onClickInfo = () => {
    if (path === BUDGET_DETAIL) return;
    const paramObj: BudgetDetailPageParams = { budget_id };
    const params = new URLSearchParams(paramObj);
    go(BUDGET_DETAIL, { params });
  };

  const onClickEdit = () => {
    go(PATH.BUDGET_CONFIG, { params: new URLSearchParams({ budget_id }) });
  };

  return (
    <LabeledBar
      key={budget_id}
      dataId={budget_id}
      barData={budget}
      iso_currency_code={iso_currency_code}
      onClickInfo={onClickInfo}
      onClickEdit={onClickEdit}
      onSetOrder={onSetOrder}
      hideEditButton={hideEditButton}
    />
  );
};
