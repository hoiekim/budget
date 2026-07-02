import { Dispatch, KeyboardEvent, SetStateAction, useEffect, useRef } from "react";
import { NewCategoryGetResponse } from "server";
import {
  Budget,
  Section,
  Category,
  Data,
  CategoryDictionary,
  PATH,
  call,
  useAppContext,
  useLocalStorageState,
  useMemoryState,
  indexedDb,
} from "client";
import { LabeledBar, CategoryBar } from "client/components";

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
    [],
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
  const sectionBarRef = useRef<HTMLDivElement>(null);
  const pendingScrollToOpen = useRef(false);

  const observerRef = useRef(
    new ResizeObserver((entries) => {
      const { height } = entries[0].contentRect;
      setChildrenHeight(height);
    }),
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
    pendingScrollToOpen.current = true;
    setIsOpen(true);
  };

  useEffect(() => {
    if (!isOpen || !pendingScrollToOpen.current) return;
    pendingScrollToOpen.current = false;
    const el = sectionBarRef.current;
    if (!el) return;
    // Wait for the children's CSS height transition (300ms per
    // BudgetDetailPage/index.css) so the unfolded height is committed
    // before we measure. Buffer a bit so `getBoundingClientRect()`
    // reads post-layout.
    const timer = window.setTimeout(() => {
      const rect = el.getBoundingClientRect();
      const viewportH = window.innerHeight;
      const overshoot = rect.bottom - viewportH;
      // Section already fits below the fold — no scroll. The whole
      // point is to minimize page motion.
      if (overshoot <= 0) return;
      // Cap the scroll delta so the section's TOP doesn't disappear
      // above the fixed top-nav header. `.Header > .viewController`
      // sits at `top: 0; height: 50px` (fixed), so the effective visible
      // top of content is y=50 — read it back off the DOM in case the
      // header ever grows a search/filter row.
      const header = document.querySelector<HTMLElement>(".Header > .viewController");
      const headerH = header ? header.getBoundingClientRect().height : 0;
      const maxDelta = Math.max(rect.top - headerH, 0);
      const delta = Math.min(overshoot, maxDelta);
      if (delta <= 0) return;
      window.scrollBy({ top: delta, behavior: "smooth" });
    }, 320);
    return () => window.clearTimeout(timer);
  }, [isOpen]);

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
        indexedDb.save(newCategory).catch(console.error);
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
    <div className="SectionBar" ref={sectionBarRef}>
      {isOpen ? (
        <div
          className="openLabel"
          onClick={onClickInfo}
          onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onClickInfo();
            }
          }}
          role="button"
          tabIndex={0}
          aria-label={`Collapse ${section.name}`}
        >
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
