import { useRef, useState, useMemo, useEffect } from "react";
import { Budget } from "server";
import { useAppContext, numberToCommaString, currencyCodeToSymbol, IsNow } from "client";
import SectionBar from "./SectionBar";
import "./index.css";

interface Props {
  budget: Budget;
}

const BudgetBar = ({ budget }: Props) => {
  const { budget_id, capacities, iso_currency_code } = budget;

  const { transactions, accounts, budgets, sections, categories, selectedInterval } =
    useAppContext();

  const [isSectionOpen, setIsSectionOpen] = useState(true);
  const [childrenHeight, setChildrenHeight] = useState(0);
  const [numeratorWidth, setNumeratorWidth] = useState(0);
  const [unlabeledNumeratorLeft, setUnlabledNumeratorLeft] = useState(0);
  const [unlabeledNumeratorWidth, setUnlabledNumeratorWidth] = useState(0);
  const [incomeNumeratorWidth, setIncomeNumeratorWidth] = useState(0);

  const capacity = capacities[selectedInterval] || 0;

  const childrenDivRef = useRef<HTMLDivElement>(null);

  const observerRef = useRef(
    new ResizeObserver((entries) => {
      const { height } = entries[0].contentRect;
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

  const sectionComponents = useMemo(() => {
    const components: JSX.Element[] = [];
    sections.forEach((e) => {
      if (e.budget_id !== budget_id) return;
      const component = <SectionBar key={e.section_id} section={e} />;
      components.push(component);
    });
    return components;
  }, [sections, budget_id]);

  const currentTotal = useMemo(() => {
    let total = 0;
    categories.forEach((e) => {
      if (!e.amount) return;
      const parentSection = sections.get(e.section_id);
      if (!parentSection) return;
      const parentBudget = budgets.get(parentSection.budget_id);
      if (!parentBudget) return;
      if (parentBudget !== budget) return;
      total += e.amount || 0;
    });
    return total;
  }, [categories, sections, budgets, budget]);

  const ratio = currentTotal / capacity || 0;

  const { unlabeledTotal, incomeTotal } = useMemo(() => {
    let unlabeledTotal = 0;
    let incomeTotal = 0;
    const isNow = new IsNow();
    transactions.forEach((e) => {
      const { account_id, authorized_date, date, label, amount } = e;
      const transactionDate = new Date(authorized_date || date);
      if (!isNow.within(selectedInterval).from(transactionDate)) return;
      const account = accounts.get(account_id);
      if (!account || account.hide) return;
      const { category_id, budget_id: labelBudgetId } = label;
      if (category_id) return;
      if ((labelBudgetId || account.label.budget_id) !== budget_id) return;
      if (amount < 0) incomeTotal -= amount;
      else unlabeledTotal += amount;
    });
    return { unlabeledTotal, incomeTotal };
  }, [selectedInterval, transactions, accounts, budget_id]);

  const unlabledRatio = unlabeledTotal / capacity || 0;
  const incomeRatio = incomeTotal / capacity || 0;

  useEffect(() => {
    setNumeratorWidth(Math.min(1, ratio) * 100);
    setUnlabledNumeratorLeft(Math.min(1, ratio) * 100);
    setUnlabledNumeratorWidth(Math.min(1 - ratio, unlabledRatio) * 100);
    setIncomeNumeratorWidth(Math.min(1, incomeRatio) * 100);
    return () => {
      setNumeratorWidth(0);
      setUnlabledNumeratorLeft(0);
      setUnlabledNumeratorWidth(0);
      setIncomeNumeratorWidth(0);
    };
  }, [ratio, unlabledRatio, incomeRatio]);

  const onClickBudgetInfo = () => {
    if (isSectionOpen) {
      setChildrenHeight(0);
      setTimeout(() => setIsSectionOpen((s) => !s), 100);
    } else {
      setIsSectionOpen((s) => !s);
    }
  };

  return (
    <div className="BudgetBar">
      <div className="budgetInfo" onClick={onClickBudgetInfo}>
        <div>Total</div>
        <div className="statusBarWithText">
          <div className="statusBar">
            <div className="contentWithoutPadding">
              <div style={{ width: numeratorWidth + "%" }} className="numerator" />
              <div
                style={{
                  border: unlabledRatio === 0 ? "none" : undefined,
                  left: unlabeledNumeratorLeft + "%",
                  width: unlabeledNumeratorWidth + "%",
                }}
                className="unlabeledNumerator"
              />
            </div>
          </div>
          <div className="infoText">
            <div>
              <span>Spent {currencyCodeToSymbol(iso_currency_code)}&nbsp;</span>
              <span className="currentTotal">{numberToCommaString(currentTotal)}</span>
            </div>
            <div>
              <span>of {currencyCodeToSymbol(iso_currency_code)}&nbsp;</span>
              <span className="capacity">{numberToCommaString(capacity)}</span>
            </div>
          </div>
          <div className="statusBar income">
            <div className="contentWithoutPadding">
              <div
                style={{ width: incomeNumeratorWidth + "%" }}
                className="incomeNumerator"
              />
            </div>
          </div>
          <div className="infoText">
            <div>
              <span>Earned {currencyCodeToSymbol(iso_currency_code)}&nbsp;</span>
              <span className="currentTotal">{numberToCommaString(incomeTotal)}</span>
            </div>
            <div className="icon">{incomeRatio >= 1 && "✓"}</div>
          </div>
        </div>
      </div>
      <div className="row-spacer" />
      <div className="children" style={{ height: childrenHeight }}>
        <div ref={childrenDivRef}>{isSectionOpen && sectionComponents}</div>
      </div>
    </div>
  );
};

export default BudgetBar;
