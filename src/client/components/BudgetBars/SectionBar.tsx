import { call, currencyCodeToSymbol, numberToCommaString, useAppContext } from "client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Budget, DeepPartial, NewCategoryGetResponse, Section } from "server";
import CategoryBar from "./CategoryBar";

interface Props {
  section: Section;
}

const SectionBar = ({ section }: Props) => {
  const { budget_id, section_id, name, capacities } = section;

  const { budgets, sections, setSections, categories, setCategories, selectedInterval } =
    useAppContext();

  const [nameInput, setNameInput] = useState(name);
  const [capacityInput, setCapacityInput] = useState(() => {
    return numberToCommaString(capacities[selectedInterval]);
  });

  const [isCategoryOpen, setIsCategoryOpen] = useState(false);
  const [childrenHeight, setChildrenHeight] = useState(0);
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

  const capacityRatio = capacity / budgetCapacity || 0;
  const currentRatio = currentTotal / capacity || 0;

  const statusBarWidth = 30 + Math.pow(Math.min(capacityRatio, 1), 0.5) * 70;

  useEffect(() => {
    setNumeratorWidth(Math.min(currentRatio, 1) * 100);
  }, [capacityRatio, currentRatio]);

  const openCategory = () => {
    setIsCategoryOpen((s) => !s);
    const childrenDiv = childrenDivRef.current;
    if (!childrenDiv) return;
    childrenDiv.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const onClickSectionInfo = () => {
    if (isCategoryOpen) setIsCategoryOpen(false);
    else if (categoryComponents.length) openCategory();
  };

  const { iso_currency_code } = budget;

  const revertInputs = () => {
    setNameInput(name);
    setCapacityInput(numberToCommaString(capacities[selectedInterval]));
  };

  type SetTimeout = typeof setTimeout;
  type Timeout = ReturnType<SetTimeout>;

  const timeout = useRef<Timeout>();

  const submit = (updatedSection: DeepPartial<Section> = {}, delay = 500) => {
    clearTimeout(timeout.current);
    timeout.current = setTimeout(async () => {
      try {
        const { status } = await call.post("/api/section", {
          ...updatedSection,
          section_id,
        });
        if (status === "success") {
          setSections((oldSections) => {
            const newSections = new Map(oldSections);
            const oldSection = oldSections.get(section_id);
            const newSection = { ...oldSection, ...updatedSection };
            newSections.set(section_id, newSection as Section);
            return newSections;
          });
        } else throw new Error(`Failed to update section: ${section_id}`);
      } catch (error: any) {
        console.error(error);
        revertInputs();
      }
    }, delay);
  };

  const onClickAdd = async () => {
    const queryString = "?" + new URLSearchParams({ parent: section_id }).toString();
    const newCategoryRequestUrl = "/api/new-category" + queryString;
    const { data } = await call.get<NewCategoryGetResponse>(newCategoryRequestUrl);

    setCategories((oldCategories) => {
      const newCategories = new Map(oldCategories);
      const category_id = data?.category_id;
      if (category_id) {
        newCategories.set(category_id, {
          category_id,
          section_id,
          name: "",
          capacities: { year: 0, month: 0, week: 0, day: 0 },
        });
      }

      return newCategories;
    });

    openCategory();
  };

  const onClickRemove = async () => {
    const queryString = "?" + new URLSearchParams({ id: section_id }).toString();
    const { status } = await call.delete("/api/section" + queryString);
    if (status === "success") {
      setSections((oldSections) => {
        const newSections = new Map(oldSections);
        newSections.delete(section_id);
        return newSections;
      });
    }
  };

  return (
    <div className="SectionBar">
      <div className="sectionInfo" onClick={onClickSectionInfo} ref={infoDivRef}>
        <div className="title">
          <input
            placeholder="name"
            value={nameInput}
            onChange={(e) => {
              const { value } = e.target;
              setNameInput(value);
              submit({ name: value });
            }}
            onClick={(e) => e.stopPropagation()}
          />
          <button onClick={onClickRemove}>✕</button>
        </div>
        <div className="statusBarWithText">
          <div style={{ width: statusBarWidth + "%" }} className="statusBar">
            <div className="contentWithoutPadding">
              <div
                style={{ width: numeratorWidth + "%" }}
                className="numerator colored"
              />
            </div>
          </div>
          <div className="infoText">
            <div>
              <span>{currencyCodeToSymbol(iso_currency_code)}&nbsp;</span>
              <span className="currentTotal">{numberToCommaString(currentTotal)}</span>
            </div>
            <div>
              <span>&nbsp;of {currencyCodeToSymbol(iso_currency_code)}&nbsp;</span>
              <input
                className="capacityInput"
                value={capacityInput}
                onKeyPress={(e) => !/[0-9.-]/.test(e.key) && e.preventDefault()}
                onChange={(e) => {
                  const { value } = e.target;
                  setCapacityInput(value);
                  submit({ capacities: { [selectedInterval]: +value } });
                }}
                onFocus={(e) => setCapacityInput(e.target.value.replaceAll(",", ""))}
                onBlur={(e) =>
                  setCapacityInput(numberToCommaString(+e.target.value || 0))
                }
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          </div>
        </div>
      </div>
      <div className="children" style={{ height: childrenHeight }}>
        <div ref={childrenDivRef}>{isCategoryOpen && categoryComponents}</div>
      </div>
      <div className="addButton">
        <button onClick={onClickAdd}>+</button>
      </div>
    </div>
  );
};

export default SectionBar;
