import { call, numberToCommaString, useAppContext } from "client";
import { useState, useEffect, useCallback, useRef } from "react";
import { Category } from "server";

interface Props {
  category: Category & { amount?: number };
}

const CategoryComponent = ({ category }: Props) => {
  const { category_id, name, capacity, amount } = category;

  const [nameInput, setNameInput] = useState(name);
  const [capacityInput, setCapacityInput] = useState(numberToCommaString(capacity));

  const { transactions, accounts, setCategories } = useAppContext();

  useEffect(() => {
    setCategories((oldCategories) => {
      const oldCategory = oldCategories.get(category_id);
      if (!oldCategory) return oldCategories;

      const newCategories = new Map(oldCategories);
      const newCategory = { ...oldCategory };

      newCategory.amount = Array.from(transactions.values()).reduce((acc, e) => {
        if (accounts.get(e.account_id)?.config?.hide) return acc;
        if (e.labels.find((f) => f.category_id === category_id)) {
          return acc - e.amount;
        }
        return acc;
      }, 0);

      newCategories.set(category_id, newCategory);

      return newCategories;
    });
  }, [transactions, accounts, setCategories, category_id]);

  const revertInputs = useCallback(() => {
    setNameInput(name);
    setCapacityInput(numberToCommaString(capacity));
  }, [name, setNameInput, capacity, setCapacityInput]);

  type SetTimeout = typeof setTimeout;
  type Timeout = ReturnType<SetTimeout>;

  const timeout = useRef<Timeout>();

  const submit = useCallback(
    (updatedCategory: Partial<Category> = {}, delay = 500) => {
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
            submit({ capacity: +value });
          }}
          onFocus={(e) => setCapacityInput(e.target.value.replaceAll(",", ""))}
          onBlur={(e) => setCapacityInput(numberToCommaString(+e.target.value || 0))}
        />
      </div>
    </div>
  );
};

export default CategoryComponent;
