import { numberToCommaString, useAppContext } from "client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Budget, Section } from "server";
import CategoryBar from "./CategoryBar";

interface Props {
  section: Section;
}

const SectionBar = ({ section }: Props) => {
  const { budget_id, section_id, name, capacities } = section;

  const { budgets, sections, categories, selectedInterval } = useAppContext();

  const [isCategoryOpen, setIsCategoryOpen] = useState(false);
  const [childrenHeight, setChildrenHeight] = useState(0);
  const [statusBarWidth, setStatusBarWidth] = useState(0);
  const [numeratorWidth, setNumeratorWidth] = useState(0);

  const capacity = capacities[selectedInterval] || 0;

  const childrenDivRef = useRef<HTMLDivElement>(null);
  const infoDivRef = useRef<HTMLDivElement>(null);

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

  const categoryComponents = useMemo(() => {
    const components: JSX.Element[] = [];
    categories.forEach((e) => {
      if (e.section_id !== section_id) return;
      const component = <CategoryBar key={e.category_id} category={e} />;
      components.push(component);
    });
    return components;
  }, [categories, section_id]);

  const currentTotal = useMemo(() => {
    let total = 0;
    categories.forEach((e) => {
      if (!e.amount) return;
      const parentSection = sections.get(e.section_id);
      if (!parentSection) return;
      if (parentSection !== section) return;
      total += e.amount || 0;
    });
    return total;
  }, [categories, sections, section]);

  const budget = budgets.get(budget_id) as Budget;
  const budgetCapacity = budget.capacities[selectedInterval] || 0;

  const capacityRatio = capacity / budgetCapacity;
  const currentRatio = currentTotal / capacity;

  useEffect(() => {
    setStatusBarWidth(30 + Math.pow(capacityRatio > 1 ? 1 : capacityRatio, 0.5) * 70);
    setNumeratorWidth((currentRatio > 1 ? 1 : currentRatio) * 100);
  }, [capacityRatio, currentRatio]);

  const onClickSectionInfo = () => {
    if (isCategoryOpen) {
      setChildrenHeight(0);
      setTimeout(() => setIsCategoryOpen((s) => !s), 100);
    } else {
      setIsCategoryOpen((s) => !s);
      const childrenDiv = childrenDivRef.current;
      if (!childrenDiv) return;
      childrenDiv.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  return (
    <div className="SectionBar">
      <div className="sectionInfo" onClick={onClickSectionInfo} ref={infoDivRef}>
        <div>{name}:</div>
        <div style={{ width: statusBarWidth + "%" }} className="statusBar">
          <div className="contentWithoutPadding">
            <div style={{ width: numeratorWidth + "%" }} className="numerator" />
          </div>
        </div>
        <div className="infoText">
          <span className="currentTotal">{numberToCommaString(currentTotal)}</span>
          <span>&nbsp;/&nbsp;</span>
          <span className="capacity">{numberToCommaString(capacity)}</span>
        </div>
      </div>
      <div className="children" style={{ height: childrenHeight }}>
        <div ref={childrenDivRef}>{isCategoryOpen && categoryComponents}</div>
      </div>
    </div>
  );
};

export default SectionBar;
