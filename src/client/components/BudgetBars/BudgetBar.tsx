import { useAppContext, numberToCommaString } from "client";
import { useRef, useState, useMemo, useEffect } from "react";
import { Budget } from "server";
import SectionBar from "./SectionBar";

interface Props {
  budget: Budget;
}

const BudgetBar = ({ budget }: Props) => {
  const { budget_id, capacities, iso_currency_code } = budget;

  const { budgets, sections, categories, selectedInterval } = useAppContext();

  const [isSectionOpen, setIsSectionOpen] = useState(true);
  const [childrenHeight, setChildrenHeight] = useState(0);

  const capacity = capacities[selectedInterval] || 0;

  const childrenDivRef = useRef<HTMLDivElement>();

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

  const ratio = currentTotal / capacity;

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
        <div>
          <span>Total:</span>
        </div>
        <div className="statusBar">
          <div className="contentWithoutPadding">
            <div
              style={{ width: (ratio > 1 ? 1 : ratio) * 100 + "%" }}
              className="numerator"
            />
          </div>
          <div className="infoText">
            <span className="currentTotal">{numberToCommaString(currentTotal)}</span>
            <span>&nbsp;/&nbsp;</span>
            <span className="capacity">{numberToCommaString(capacity)}</span>
            <span>&nbsp;{iso_currency_code}</span>
          </div>
        </div>
      </div>
      <div className="row-spacer" />
      <div className="children" style={{ height: childrenHeight }}>
        <div
          ref={(e) => {
            if (!e) return;
            childrenDivRef.current = e;
          }}
        >
          {isSectionOpen && sectionComponents}
        </div>
      </div>
    </div>
  );
};

export default BudgetBar;
