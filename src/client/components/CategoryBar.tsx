import { Dispatch, SetStateAction } from "react";
import { Budget, Category, Section } from "common";
import { useAppContext, PATH, ScreenType } from "client";
import { LabeledBar } from "client/components";

interface Props {
  category: Category & { amount?: number };
  onSetOrder?: Dispatch<SetStateAction<string[]>>;
}

export const CategoryBar = ({ category, onSetOrder }: Props) => {
  const { section_id, category_id } = category;

  const { data, router, screenType } = useAppContext();
  const { budgets, sections } = data;

  const section = sections.get(section_id) as Section;
  const budget_id = section.budget_id;
  const budget = budgets.get(budget_id) as Budget;

  const onClickInfo = () => {
    const params = new URLSearchParams(router.params);
    if (params.get("category_id") === category_id) params.delete("category_id");
    else params.set("category_id", category_id);
    if (screenType === ScreenType.Narrow) {
      params.delete("transactions_type");
      router.go(PATH.TRANSACTIONS, { params });
    } else {
      router.go(router.path, { params, animate: false });
    }
  };

  const onClickEdit = () => {
    router.go(PATH.BUDGET_CONFIG, { params: new URLSearchParams({ category_id }) });
  };

  const { iso_currency_code } = budget;

  return (
    <div className="CategoryBar">
      <LabeledBar
        dataId={category_id}
        barData={category}
        iso_currency_code={iso_currency_code}
        onClickInfo={onClickInfo}
        onClickEdit={onClickEdit}
        onSetOrder={onSetOrder}
      />
    </div>
  );
};
