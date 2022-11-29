import {
  numberToCommaString,
  useAppContext,
  currencyCodeToSymbol,
  call,
  PATH,
} from "client";
import { useState, useRef } from "react";
import { Budget, Category, DeepPartial, Section } from "server";
import { Bar, CapacityInput, EditButton, NameInput } from "./common";

interface Props {
  category: Category & { amount?: number };
}

const CategoryComponent = ({ category }: Props) => {
  const { section_id, category_id, name, capacities, amount } = category;

  const { transactions, budgets, sections, setCategories, selectedInterval, router } =
    useAppContext();

  const [isEditting, setIsEditting] = useState(!name);

  const capacity = capacities[selectedInterval] || 0;

  const infoDivRef = useRef<HTMLDivElement>(null);

  const section = sections.get(section_id) as Section;
  const budget_id = section.budget_id;

  const budget = budgets.get(budget_id) as Budget;
  const budgetCapacity = budget.capacities[selectedInterval] || 0;

  const capacityRatio = capacity / budgetCapacity || 0;
  const currentRatio = (amount || 0) / capacity || 0;

  const statusBarWidth = 30 + Math.pow(Math.min(capacityRatio, 1), 0.5) * 70;

  const onClickCategoryInfo = () => {
    const params = new URLSearchParams({ category_id });
    router.go(PATH.TRANSACTIONS, { params });
  };

  const { iso_currency_code } = budget;

  type SetTimeout = typeof setTimeout;
  type Timeout = ReturnType<SetTimeout>;

  const timeout = useRef<Timeout>();

  const submit = (updatedCategory: DeepPartial<Category> = {}, onError?: () => void) => {
    clearTimeout(timeout.current);
    timeout.current = setTimeout(async () => {
      try {
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
      } catch (error: any) {
        console.error(error);
        if (onError) onError();
      }
    }, 500);
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

  const onEdit = () => setIsEditting((s) => !s);

  return (
    <div className="CategoryBar">
      <div
        className="categoryInfo"
        onClick={onClickCategoryInfo}
        onMouseLeave={() => setIsEditting(false)}
        ref={infoDivRef}
      >
        <div className="title">
          <NameInput
            defaultValue={name}
            isEditting={isEditting}
            submit={(value, onError) => {
              submit({ name: value }, onError);
            }}
          />
          <div className="buttons">
            <EditButton isEditting={isEditting} onEdit={onEdit} onDelete={onDelete} />
          </div>
        </div>
        <div className="statusBarWithText">
          <Bar style={{ width: statusBarWidth + "%" }} ratio={currentRatio} />
          <div className="infoText">
            <div>
              <span>{currencyCodeToSymbol(iso_currency_code)}&nbsp;</span>
              <span className="currentTotal">{numberToCommaString(amount || 0)}</span>
            </div>
            <div>
              <span>&nbsp;of {currencyCodeToSymbol(iso_currency_code)}&nbsp;</span>
              <CapacityInput
                key={`${category_id}_${selectedInterval}`}
                defaultValue={numberToCommaString(capacity)}
                isEditting={isEditting}
                submit={(value, onError) => {
                  submit({ capacities: { [selectedInterval]: +value } }, onError);
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CategoryComponent;
