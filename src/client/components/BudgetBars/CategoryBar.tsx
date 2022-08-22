import { numberToCommaString, useAppContext, TransactionsTable, IsNow } from "client";
import { useState, useMemo, useRef, useEffect } from "react";
import { Budget, Category, Section, Transaction } from "server";

interface Props {
  category: Category & { amount?: number };
}

const CategoryComponent = ({ category }: Props) => {
  const { section_id, category_id, name, capacities, amount } = category;

  const { transactions, accounts, budgets, sections, selectedInterval } = useAppContext();
  const [isTransactionOpen, setIsTransactionOpen] = useState(false);
  const [childrenHeight, setChildrenHeight] = useState(0);

  const capacity = capacities[selectedInterval] || 0;

  const childrenDivRef = useRef<HTMLDivElement>();
  const infoDivRef = useRef<HTMLDivElement>();
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

  const capacityRatio = capacity / budgetCapacity;
  const statusBarWidth = 30 + Math.pow(capacityRatio > 1 ? 1 : capacityRatio, 0.5) * 70;

  const currentRatio = (amount || 0) / capacity;
  const numeratorWidth = (currentRatio > 1 ? 1 : currentRatio) * 100;

  const transactionsArray = useMemo(() => {
    const array: Transaction[] = [];
    const isNow = new IsNow();
    transactions.forEach((e) => {
      const hidden = accounts.get(e.account_id)?.hide;
      const transactionDate = new Date(e.authorized_date || e.date);
      const within = isNow.within(selectedInterval).from(transactionDate);
      const includedInCategory = e.label.category_id === category_id;
      if (!hidden && within && includedInCategory) array.push(e);
    });
    return array.sort((a, b) => (a.transaction_id > b.transaction_id ? 1 : -1));
  }, [category_id, transactions, accounts, selectedInterval]);

  const onClickCategoryInfo = () => {
    if (isTransactionOpen) {
      setChildrenHeight(0);
      setTimeout(() => setIsTransactionOpen((s) => !s), 100);
    } else {
      setIsTransactionOpen((s) => !s);
      const infoDiv = infoDivRef.current;
      if (!infoDiv) return;
      infoDiv.scrollIntoView({ behavior: "smooth" });
    }
  };

  return (
    <div className="CategoryBar">
      <div
        className="categoryInfo"
        onClick={onClickCategoryInfo}
        ref={(e) => {
          if (e) infoDivRef.current = e;
        }}
      >
        <div>{name}:</div>
        <div style={{ width: statusBarWidth + "%" }} className="statusBar">
          <div className="contentWithoutPadding">
            <div style={{ width: numeratorWidth + "%" }} className="numerator" />
          </div>
        </div>
        <div className="infoText">
          <span className="currentTotal">{numberToCommaString(amount || 0)}</span>
          <span>&nbsp;/&nbsp;</span>
          <span className="capacity">{numberToCommaString(capacity)}</span>
        </div>
      </div>
      <div className="children" style={{ height: childrenHeight }}>
        <div
          ref={(e) => {
            if (e) childrenDivRef.current = e;
          }}
        >
          {isTransactionOpen && (
            <TransactionsTable transactionsArray={transactionsArray} />
          )}
        </div>
      </div>
    </div>
  );
};

export default CategoryComponent;
