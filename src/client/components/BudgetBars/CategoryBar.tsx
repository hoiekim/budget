import {
  numberToCommaString,
  useAppContext,
  IsDate,
  currencyCodeToSymbol,
  call,
} from "client";
import { useState, useRef, useEffect } from "react";
import { Budget, Category, DeepPartial, Section, Transaction } from "server";
import { Bar, CapacityInput, EditButton, NameInput, TransactionsList } from "./common";

interface Props {
  category: Category & { amount?: number };
}

const CategoryComponent = ({ category }: Props) => {
  const { section_id, category_id, name, capacities, amount } = category;

  const {
    transactions,
    accounts,
    budgets,
    sections,
    setCategories,
    selectedInterval,
    viewDate,
  } = useAppContext();

  const [isTransactionOpen, setIsTransactionOpen] = useState(false);
  const [childrenHeight, setChildrenHeight] = useState(0);
  const [transactionsArray, setTransactionsArray] = useState<Transaction[]>([]);
  const [isEditting, setIsEditting] = useState(!name);

  const capacity = capacities[selectedInterval] || 0;

  const childrenDivRef = useRef<HTMLDivElement>(null);
  const infoDivRef = useRef<HTMLDivElement>(null);

  const observerRef = useRef(
    new ResizeObserver((entries) => {
      const element = entries[0];
      const { height } = element.contentRect;
      setChildrenHeight(height);
    })
  );

  useEffect(() => {
    const childrenDiv = childrenDivRef.current;
    const observer = observerRef.current;
    if (childrenDiv) observer.observe(childrenDiv);
    return () => {
      if (childrenDiv) observer.unobserve(childrenDiv);
    };
  }, []);

  const section = sections.get(section_id) as Section;
  const budget_id = section.budget_id;

  const budget = budgets.get(budget_id) as Budget;
  const budgetCapacity = budget.capacities[selectedInterval] || 0;

  const capacityRatio = capacity / budgetCapacity || 0;
  const currentRatio = (amount || 0) / capacity || 0;

  const statusBarWidth = 30 + Math.pow(Math.min(capacityRatio, 1), 0.5) * 70;

  const onClickCategoryInfo = () => {
    if (isTransactionOpen) {
      setChildrenHeight(0);
      setTimeout(() => setIsTransactionOpen((s) => !s), 100);
      return;
    } else if (transactionsArray.length) {
    }
    const newTransactionsArray = [...transactionsArray];
    if (!newTransactionsArray.length) {
      const isViewDate = new IsDate(viewDate);
      transactions.forEach((e) => {
        const hidden = accounts.get(e.account_id)?.hide;
        const transactionDate = new Date(e.authorized_date || e.date);
        const within = isViewDate.within(selectedInterval).from(transactionDate);
        const includedInCategory = e.label.category_id === category_id;
        if (!hidden && within && includedInCategory) newTransactionsArray.push(e);
      });
    }
    setTransactionsArray(newTransactionsArray);
    setIsTransactionOpen((s) => !s);
    const childrenDiv = childrenDivRef.current;
    if (childrenDiv) {
      childrenDiv.scrollIntoView({ behavior: "smooth", block: "center" });
    }
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
      <div className="children" style={{ height: childrenHeight }}>
        <div ref={childrenDivRef}>
          {isTransactionOpen && (
            <TransactionsList transactionsArray={transactionsArray} />
          )}
        </div>
      </div>
    </div>
  );
};

export default CategoryComponent;
