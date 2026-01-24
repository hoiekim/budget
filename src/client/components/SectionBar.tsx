import { Dispatch, SetStateAction, useEffect, useRef } from "react";
import { NewCategoryGetResponse } from "server";
import { PATH, call, useAppContext, useLocalStorageState, useMemoryState } from "client";
import { LabeledBar, CategoryBar } from "client/components";
import { Budget, Section, Category, Data, CategoryDictionary } from "common";

interface Props {
  section: Section & { sorted_amount?: number };
  onSetOrder?: Dispatch<SetStateAction<string[]>>;
}

export const SectionBar = ({ section, onSetOrder }: Props) => {
  const { budget_id, section_id } = section;

  const { data, setData, router } = useAppContext();
  const { budgets, categories } = data;

  const isOpenKey = `section_${section_id}_isOpen`;
  const [isOpen, setIsOpen] = useMemoryState(isOpenKey, false);

  const childrenHiehgtKey = `section_${section_id}_childrenHeight`;
  const [childrenHeight, setChildrenHeight] = useMemoryState(childrenHiehgtKey, 0);

  const [categoriesOrder, setCategoriesOrder] = useLocalStorageState<string[]>(
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
      const indexA = categoriesOrder.indexOf(a);
      const indexB = categoriesOrder.indexOf(b);
      if (indexA === undefined || indexB === undefined) return 0;
      return indexA - indexB;
    })
    .map(([category_id, category]) => {
      return <CategoryBar key={category_id} category={category} onSetOrder={setCategoriesOrder} />;
    });

  const budget = budgets.get(budget_id) as Budget;
  const { iso_currency_code } = budget;

  const openCategory = () => {
    setIsOpen(true);
    const childrenDiv = childrenDivRef.current;
    if (!childrenDiv) return;
    childrenDiv.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const onClickInfo = () => {
    const params = new URLSearchParams(router.params);
    params.delete("category_id");
    params.delete("section_id");
    if (isOpen) {
      setIsOpen(false);
    } else {
      params.set("section_id", section_id);
      openCategory();
    }
    router.go(router.path, { params, animate: false });
  };

  const onClickEdit = () => {
    router.go(PATH.BUDGET_CONFIG, { params: new URLSearchParams({ section_id }) });
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

    router.go(PATH.BUDGET_CONFIG, { params: new URLSearchParams({ category_id }) });
  };

  const childrenClassNames = ["children", "transition"];

  return (
    <div className="SectionBar">
      {isOpen ? (
        <div className="openLabel" onClick={onClickInfo}>
          <span>{section.name}</span>
        </div>
      ) : (
        <LabeledBar
          dataId={section_id}
          barData={section}
          iso_currency_code={iso_currency_code}
          onClickInfo={onClickInfo}
          onClickEdit={onClickEdit}
          onSetOrder={onSetOrder}
        />
      )}
      <div className={childrenClassNames.join(" ")} style={{ height: childrenHeight }}>
        <div ref={childrenDivRef}>
          {isOpen && (
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
