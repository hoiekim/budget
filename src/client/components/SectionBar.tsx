import { Dispatch, SetStateAction, useEffect, useRef, useState } from "react";
import { NewCategoryGetResponse } from "server";
import { PATH, call, useAppContext, useLocalStorage } from "client";
import { LabeledBar, CategoryBar } from "client/components";
import { getIndex, Budget, Section, Category, Data, CategoryDictionary } from "common";

interface Props {
  section: Section & { sorted_amount?: number };
  onSetOrder?: Dispatch<SetStateAction<string[]>>;
}

const SectionBar = ({ section, onSetOrder }: Props) => {
  const { budget_id, section_id } = section;

  const { data, setData, router } = useAppContext();
  const { budgets, categories } = data;

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
  }, [categories, section_id, setCategoriesOrder]);

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

  const onClickAddCategory = async () => {
    const queryString = "?" + new URLSearchParams({ parent: section_id }).toString();
    const newCategoryRequestUrl = "/api/new-category" + queryString;
    const { body } = await call.get<NewCategoryGetResponse>(newCategoryRequestUrl);

    if (!body) return;

    const { category_id } = body;

    setData((oldData) => {
      if (category_id) {
        const newData = new Data(oldData);
        const newCategory = new Category({ category_id, section_id });
        const newCategories = new CategoryDictionary(newData.categories);
        newCategories.set(category_id, newCategory);
        newData.categories = newCategories;
        return newData;
      }
      return oldData;
    });

    router.go(PATH.BUDGET_CONFIG, { params: new URLSearchParams({ id: category_id }) });
  };

  return (
    <div className="SectionBar">
      <LabeledBar
        dataId={section_id}
        data={section}
        iso_currency_code={iso_currency_code}
        onClickInfo={onClickInfo}
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
