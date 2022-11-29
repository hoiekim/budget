import { call, currencyCodeToSymbol, numberToCommaString, useAppContext } from "client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Budget, DeepPartial, NewCategoryGetResponse, Section } from "server";
import { Bar, CapacityInput, EditButton, NameInput } from "./common";
import CategoryBar from "./CategoryBar";

interface Props {
  section: Section & { amount?: number };
}

const SectionBar = ({ section }: Props) => {
  const { budget_id, section_id, name, capacities, amount } = section;

  const { budgets, setSections, categories, setCategories, selectedInterval } =
    useAppContext();

  const [isCategoryOpen, setIsCategoryOpen] = useState(false);
  const [childrenHeight, setChildrenHeight] = useState(0);
  const [isEditting, setIsEditting] = useState(!name);

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

  const budget = budgets.get(budget_id) as Budget;
  const budgetCapacity = budget.capacities[selectedInterval] || 0;

  const capacityRatio = capacity / budgetCapacity || 0;
  const currentRatio = (amount || 0) / capacity || 0;

  const statusBarWidth = 30 + Math.pow(Math.min(capacityRatio, 1), 0.5) * 70;

  const openCategory = () => {
    setIsCategoryOpen(true);
    const childrenDiv = childrenDivRef.current;
    if (!childrenDiv) return;
    childrenDiv.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const onClickSectionInfo = () => {
    if (isCategoryOpen) setIsCategoryOpen(false);
    else openCategory();
  };

  const { iso_currency_code } = budget;

  type SetTimeout = typeof setTimeout;
  type Timeout = ReturnType<SetTimeout>;

  const timeout = useRef<Timeout>();

  const submit = (updatedSection: DeepPartial<Section> = {}, onError?: () => void) => {
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
        if (onError) onError();
      }
    }, 500);
  };

  const onClickAddCategory = async () => {
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

  const onDelete = async () => {
    let sectionIterator = categories.values();
    let iteratorResult = sectionIterator.next();
    let isSectionUsed: boolean | undefined;
    while (!iteratorResult.done) {
      const category = iteratorResult.value;
      if (category.section_id === section_id) {
        isSectionUsed = true;
        break;
      }
      iteratorResult = sectionIterator.next();
    }

    if (isSectionUsed) {
      const sectionName = name || "Unnamed";
      const confirm = window.confirm(`Do you want to delete section: ${sectionName}?`);
      if (!confirm) return;
    }

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

  const onEdit = () => setIsEditting((s) => !s);

  return (
    <div className="SectionBar">
      <div
        className="sectionInfo"
        onClick={onClickSectionInfo}
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
                key={`${section_id}_${selectedInterval}`}
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
          {isCategoryOpen && (
            <>
              {categoryComponents}
              <div className="addButton">
                <button onClick={onClickAddCategory}>+</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default SectionBar;
