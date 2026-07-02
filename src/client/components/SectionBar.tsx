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
    const childrenEl = childrenDivRef.current;
    if (!el || !childrenEl) return;
    // Fixed regions clipping the visible area. `.Header > .viewController`
    // is the top nav (`fixed; top:0; height:50px`). `.Header > .navigators`
    // is either the bottom bar on narrow (`fixed; bottom:0`) or a side
    // rail on wide (`top:50; width:80px`); it clips the scroll region
    // only when it's the bottom bar.
    const header = document.querySelector<HTMLElement>(".Header > .viewController");
    const headerH = header ? header.getBoundingClientRect().height : 0;
    const navs = document.querySelector<HTMLElement>(".Header > .navigators");
    const isNavAtBottom =
      !!navs && !navs.parentElement?.classList.contains("wideScreen");
    const navH = isNavAtBottom ? navs.getBoundingClientRect().height : 0;
    const rect0 = el.getBoundingClientRect();
    const projectedBottom = rect0.bottom + childrenEl.scrollHeight;
    const visibleBottom = window.innerHeight - navH;
    const overshoot = projectedBottom - visibleBottom;
    if (overshoot <= 0) return;
    const maxDelta = Math.max(rect0.top - headerH, 0);
    const delta = Math.min(overshoot, maxDelta);
    if (delta <= 0) return;
    // Custom rAF-driven scroll instead of `scrollBy({behavior:"smooth"})`.
    // The native smooth API clamps to `docHeight − innerHeight` at
    // animation-start time and doesn't re-target if the doc grows —
    // which it will, since the CSS `.children.transition` is animating
    // in parallel with us. A rAF loop re-issues `scrollTo(target)`
    // every frame, so the browser's per-frame clamp naturally makes
    // progress as the doc grows. Runs on the same 300ms budget as the
    // CSS transition so the two animations feel coordinated.
    const startY = window.scrollY;
    const target = startY + delta;
    const startedAt = performance.now();
    const DURATION = 300;
    let rafId = 0;
    const step = (now: number) => {
      const t = Math.min((now - startedAt) / DURATION, 1);
      // Ease-out cubic — matches feel of CSS transition's default.
      const eased = 1 - Math.pow(1 - t, 3);
      const y = startY + (target - startY) * eased;
      window.scrollTo(0, y);
      if (t < 1) rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
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
