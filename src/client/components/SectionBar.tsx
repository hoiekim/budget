import { Dispatch, SetStateAction, useEffect, useRef, useState } from "react";
import { Budget, DeepPartial, NewCategoryGetResponse, Section } from "server";
import { call, getIndex, useAppContext, useLocalStorage } from "client";
import { LabeledBar, CategoryBar } from "client/components";

interface Props {
  section: Section & { sorted_amount?: number };
  editingState?: [string | null, Dispatch<SetStateAction<string | null>>];
  onSetOrder?: Dispatch<SetStateAction<string[]>>;
}

const SectionBar = ({ section, editingState, onSetOrder }: Props) => {
  const { budget_id, section_id, name } = section;

  const { budgets, setSections, categories, setCategories } = useAppContext();

  const [isCategoryOpen, setIsCategoryOpen] = useState(false);
  const [childrenHeight, setChildrenHeight] = useState(0);

  const [categoriesOrder, setCategoriesOrder] = useLocalStorage<string[]>(
    `categoriesOrder_${section_id}`,
    []
  );

  useEffect(() => {
    setCategoriesOrder((oldOrder) => {
      const set = new Set(oldOrder);
      categories.forEach((category, key) => {
        if (category.section_id === section_id) set.add(key);
      });
      return Array.from(set.values());
    });
  }, [categories, setCategoriesOrder]);

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

  const categoryBars = Array.from(categories)
    .filter(([_category_id, category]) => category.section_id === section_id)
    .sort(([a], [b]) => {
      const indexA = getIndex(a, categoriesOrder);
      const indexB = getIndex(b, categoriesOrder);
      if (indexA === undefined || indexB === undefined) return 0;
      return indexA - indexB;
    })
    .map(([category_id, category]) => {
      return (
        <CategoryBar
          key={category_id}
          category={category}
          editingState={editingState}
          onSetOrder={setCategoriesOrder}
        />
      );
    });

  const budget = budgets.get(budget_id) as Budget;
  const { iso_currency_code } = budget;

  const openCategory = () => {
    setIsCategoryOpen(true);
    const childrenDiv = childrenDivRef.current;
    if (!childrenDiv) return;
    childrenDiv.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const onClickInfo = () => {
    if (isCategoryOpen) setIsCategoryOpen(false);
    else openCategory();
  };

  const onSubmit = async (updatedSection: DeepPartial<Section> = {}) => {
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
  };

  const onClickAddCategory = async () => {
    const queryString = "?" + new URLSearchParams({ parent: section_id }).toString();
    const newCategoryRequestUrl = "/api/new-category" + queryString;
    const { data } = await call.get<NewCategoryGetResponse>(newCategoryRequestUrl);

    if (!data) return;

    const { category_id } = data;

    setCategories((oldCategories) => {
      const newCategories = new Map(oldCategories);
      if (category_id) {
        newCategories.set(category_id, {
          category_id,
          section_id,
          name: "",
          capacities: { year: 0, month: 0, week: 0, day: 0 },
          roll_over: false,
        });
      }
      return newCategories;
    });

    if (editingState) editingState[1](category_id);
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

  return (
    <div className="SectionBar">
      <LabeledBar
        dataId={section_id}
        data={section}
        iso_currency_code={iso_currency_code}
        onSubmit={onSubmit}
        onDelete={onDelete}
        onClickInfo={onClickInfo}
        editingState={editingState}
        onSetOrder={onSetOrder}
      />
      <div className="children" style={{ height: childrenHeight }}>
        <div ref={childrenDivRef}>
          {isCategoryOpen && (
            <>
              {categoryBars}
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
