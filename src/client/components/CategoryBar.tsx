import { Dispatch, SetStateAction } from "react";
import { Budget, Category, Section } from "common";
import { useAppContext, PATH, TransactionsPageParams } from "client";
import { LabeledBar } from "client/components";

interface Props {
  category: Category & { amount?: number };
  onSetOrder?: Dispatch<SetStateAction<string[]>>;
}

const CategoryComponent = ({ category, onSetOrder }: Props) => {
  const { section_id, category_id } = category;

  const { data, router } = useAppContext();
  const { budgets, sections } = data;

  const section = sections.get(section_id) as Section;
  const budget_id = section.budget_id;
  const budget = budgets.get(budget_id) as Budget;

  const onClickInfo = () => {
    const paramObj: TransactionsPageParams = { category_id };
    const params = new URLSearchParams(paramObj);
    router.go(PATH.TRANSACTIONS, { params });
  };

  const { iso_currency_code } = budget;

  return (
    <div className="CategoryBar">
      <LabeledBar
        dataId={category_id}
        data={category}
        iso_currency_code={iso_currency_code}
        onClickInfo={onClickInfo}
        onSetOrder={onSetOrder}
      />
    </div>
  );
};

export default CategoryComponent;
