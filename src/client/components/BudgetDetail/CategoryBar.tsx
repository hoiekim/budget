import { Dispatch, SetStateAction } from "react";
import { Budget, Category, DeepPartial, Section } from "server";
import { useAppContext, call, PATH } from "client";
import { LabeledBar } from "client/components";

interface Props {
  category: Category & { amount?: number };
  editingState?: [string | null, Dispatch<SetStateAction<string | null>>];
}

const CategoryComponent = ({ category, editingState }: Props) => {
  const { section_id, category_id, name } = category;

  const { transactions, budgets, sections, setCategories, router } = useAppContext();

  const section = sections.get(section_id) as Section;
  const budget_id = section.budget_id;
  const budget = budgets.get(budget_id) as Budget;

  const onClickInfo = () => {
    const params = new URLSearchParams({ category_id });
    router.go(PATH.TRANSACTIONS, { params });
  };

  const { iso_currency_code } = budget;

  const onSubmit = async (updatedCategory: DeepPartial<Category> = {}) => {
    const { status } = await call.post("/api/category", {
      ...updatedCategory,
      category_id,
    });
    if (status === "success") {
      setCategories((oldCategories) => {
        const newCategories = new Map(oldCategories);
        const oldCategory = oldCategories.get(category_id);
        const newCategory = { ...oldCategory, ...updatedCategory };
        newCategories.set(category_id, newCategory as Category);
        return newCategories;
      });
    } else throw new Error(`Failed to update category: ${category_id}`);
  };

  const onDelete = async () => {
    let transactionIterator = transactions.values();
    let iteratorResult = transactionIterator.next();
    let isCategoryUsed: boolean | undefined;
    while (!iteratorResult.done) {
      const transaction = iteratorResult.value;
      if (transaction.label.category_id === category_id) {
        isCategoryUsed = true;
        break;
      }
      iteratorResult = transactionIterator.next();
    }

    if (isCategoryUsed) {
      const categoryName = name || "Unnamed";
      const confirm = window.confirm(`Do you want to delete category: ${categoryName}?`);
      if (!confirm) return;
    }

    const queryString = "?" + new URLSearchParams({ id: category_id }).toString();
    const { status } = await call.delete("/api/category" + queryString);
    if (status === "success") {
      setCategories((oldCategories) => {
        const newCategories = new Map(oldCategories);
        newCategories.delete(category_id);
        return newCategories;
      });
    }
  };

  return (
    <div className="CategoryBar">
      <LabeledBar
        dataId={section_id}
        data={section}
        iso_currency_code={iso_currency_code}
        onSubmit={onSubmit}
        onDelete={onDelete}
        onClickInfo={onClickInfo}
        editingState={editingState}
      />
    </div>
  );
};

export default CategoryComponent;
