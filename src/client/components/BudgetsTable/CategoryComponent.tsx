import { call, numberToCommaString, useAppContext, IsNow, DeepPartial } from "client";
import { useState, useEffect, useCallback, useRef } from "react";
import { Category } from "server";

interface Props {
  category: Category & { amount?: number };
}

const CategoryComponent = ({ category }: Props) => {
  const { category_id, name, capacity, amount } = category;

  const {
    transactions,
    accounts,
    budgets,
    setCategories,
    selectedBudgetId,
    selectedInterval,
  } = useAppContext();
  const [nameInput, setNameInput] = useState(name);
  const [capacityInput, setCapacityInput] = useState(
    numberToCommaString(capacity[selectedInterval])
  );

  useEffect(() => {
    setCategories((oldCategories) => {
      const oldCategory = oldCategories.get(category_id);
      if (!oldCategory) return oldCategories;

      const newCategories = new Map(oldCategories);
      const newCategory = { ...oldCategory };

      const budget = budgets.get(selectedBudgetId);
      if (!budget) return oldCategories;

      const isNow = new IsNow();

      newCategory.amount = Array.from(transactions.values())
        .filter((e) => {
          const transactionDate = new Date(e.authorized_date || e.date);
          return isNow.within(selectedInterval).from(transactionDate);
        })
        .reduce((acc, e) => {
          const account = accounts.get(e.account_id);
          if (account?.hide) return acc;
          if (e.label.category_id === category_id) {
            return acc - e.amount;
          }
          return acc;
        }, 0);

      newCategories.set(category_id, newCategory);

      return newCategories;
    });
  }, [
    transactions,
    accounts,
    setCategories,
    category_id,
    budgets,
    selectedBudgetId,
    selectedInterval,
  ]);

  const revertInputs = useCallback(() => {
    setNameInput(name);
    setCapacityInput(numberToCommaString(capacity[selectedInterval]));
  }, [name, setNameInput, capacity, setCapacityInput, selectedInterval]);

  type SetTimeout = typeof setTimeout;
  type Timeout = ReturnType<SetTimeout>;

  const timeout = useRef<Timeout>();

  const submit = useCallback(
    (updatedCategory: DeepPartial<Category> = {}, delay = 500) => {
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
          revertInputs();
        }
      }, delay);
    },
    [setCategories, category_id, revertInputs]
  );

  const onClickRemove = useCallback(async () => {
    const queryString = "?" + new URLSearchParams({ id: category_id }).toString();
    const { status } = await call.delete("/api/category" + queryString);
    if (status === "success") {
      setCategories((oldCategories) => {
        const newCategories = new Map(oldCategories);
        newCategories.delete(category_id);
        return newCategories;
      });
    }
  }, [category_id, setCategories]);

  return (
    <div className="CategoryComponent">
      <div className="categoryInfo">
        <button onClick={onClickRemove}>-</button>
        <input
          placeholder="name"
          value={nameInput}
          onChange={(e) => {
            const { value } = e.target;
            setNameInput(value);
            submit({ name: value });
          }}
        />
        <div className="currentTotal">{numberToCommaString(amount || 0)}</div>
        <span> / </span>
        <input
          value={capacityInput}
          onKeyPress={(e) => !/[0-9.-]/.test(e.key) && e.preventDefault()}
          onChange={(e) => {
            const { value } = e.target;
            setCapacityInput(value);
            submit({ capacity: { [selectedInterval]: +value } });
          }}
          onFocus={(e) => setCapacityInput(e.target.value.replaceAll(",", ""))}
          onBlur={(e) => setCapacityInput(numberToCommaString(+e.target.value || 0))}
        />
      </div>
    </div>
  );
};

export default CategoryComponent;
