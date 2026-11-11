import { afterEach, describe, expect, it } from "bun:test";
import { useMemo, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MAX_FLOAT } from "common";
import {
  Budget,
  BudgetDictionary,
  Calculations,
  Capacity,
  Category,
  CategoryDictionary,
  Context,
  ContextType,
  Data,
  PATH,
  Section,
  SectionDictionary,
  globalData,
} from "client";
import { buildContext, buildRouter, renderWithContext, resetDom, stubFetch } from "test-render";
import { BudgetConfigPage } from ".";

let fetchStub: ReturnType<typeof stubFetch> | undefined;
const originalConfirm = window.confirm;

afterEach(() => {
  cleanup();
  fetchStub?.restore();
  fetchStub = undefined;
  window.confirm = originalConfirm;
  resetDom();
});

const BUDGET_ID = "budget-under-edit";

const buildData = (overrides: Partial<Budget> = {}) => {
  const data = new Data();
  const budget = new Budget({
    budget_id: BUDGET_ID,
    name: "Groceries",
    capacities: [new Capacity({ month: 500 })],
    ...overrides,
  });
  data.budgets.set(BUDGET_ID, budget);
  return data;
};

const buildConfigContext = (data: Data, overrides: Partial<ContextType> = {}) => {
  const { router } = buildRouter(PATH.BUDGET_CONFIG, new URLSearchParams({ budget_id: BUDGET_ID }));
  return buildContext({ data, router, ...overrides });
};

const nameField = () => screen.getByPlaceholderText("name") as HTMLInputElement;

// Budget 1200 with section A (500, one category at 300) and childless
// section B (500) — the sync-toggle repro family, shared by the sync-toggle tests.
// `getChildren`/`getParent` traverse the `globalData` singleton, not the
// context data, so the family has to live in both for the save. Callers
// must reset globalData in a finally block (see the budget-toggle test).
const buildSyncFamily = () => {
  const SECTION_A_ID = "section-a";
  const SECTION_B_ID = "section-b";
  const CATEGORY_ID = "category-a1";
  const data = new Data();
  const budget = new Budget({
    budget_id: BUDGET_ID,
    name: "QA",
    capacities: [new Capacity({ month: 1200 })],
  });
  const sectionA = new Section({
    section_id: SECTION_A_ID,
    budget_id: BUDGET_ID,
    name: "A",
    capacities: [new Capacity({ month: 500 })],
  });
  const sectionB = new Section({
    section_id: SECTION_B_ID,
    budget_id: BUDGET_ID,
    name: "B",
    capacities: [new Capacity({ month: 500 })],
  });
  const category = new Category({
    category_id: CATEGORY_ID,
    section_id: SECTION_A_ID,
    name: "A1",
    capacities: [new Capacity({ month: 300 })],
  });
  data.budgets.set(BUDGET_ID, budget);
  data.sections.set(SECTION_A_ID, sectionA);
  data.sections.set(SECTION_B_ID, sectionB);
  data.categories.set(CATEGORY_ID, category);
  globalData.budgets.set(BUDGET_ID, budget);
  globalData.sections.set(SECTION_A_ID, sectionA);
  globalData.sections.set(SECTION_B_ID, sectionB);
  globalData.categories.set(CATEGORY_ID, category);
  return { data, SECTION_A_ID, SECTION_B_ID, CATEGORY_ID };
};

const resetGlobalData = () => {
  globalData.budgets = new BudgetDictionary();
  globalData.sections = new SectionDictionary();
  globalData.categories = new CategoryDictionary();
};

const syncToggle = () => {
  const row = screen.getByText("Sync with children").closest(".row");
  return row?.querySelector('input[type="checkbox"]') as HTMLInputElement;
};

const limitedToggle = () => {
  const row = screen.getByText("Limited budget").closest(".row");
  return row?.querySelector('input[type="checkbox"]') as HTMLInputElement;
};

const stubSaveEndpoints = () =>
  stubFetch([
    { path: "/api/budget", response: { status: "success" } },
    { path: "/api/section", response: { status: "success" } },
    { path: "/api/category", response: { status: "success" } },
  ]);

const rollOverToggle = () => {
  const row = screen.getByText("Rolls over to the next period").closest(".row");
  return row?.querySelector('input[type="checkbox"]') as HTMLInputElement;
};

/**
 * The default test context stubs `calculate.cache.capacityData` as a no-op,
 * so a render-phase AppContext update would never fire under it. This
 * harness wires the real cache updater — a setState on the context provider —
 * so clicking Add New Period on the old code reproduces React's "Cannot
 * update a component" warning instead of passing silently.
 */
const RealCacheHarness = ({ data }: { data: Data }) => {
  const [calculations, setCalculations] = useState(new Calculations());
  const calculate = useMemo(() => {
    const fn = (() => {}) as unknown as ContextType["calculate"];
    fn.cache = {
      capacityData: (updater) => {
        setCalculations((old) => {
          const next = new Calculations(old);
          next.update({ capacityData: updater(old.capacityData) });
          return next;
        });
      },
    };
    return fn;
  }, []);
  const { router } = buildRouter(PATH.BUDGET_CONFIG, new URLSearchParams({ budget_id: BUDGET_ID }));
  return (
    <Context.Provider value={buildContext({ data, calculations, calculate, router })}>
      <BudgetConfigPage />
    </Context.Provider>
  );
};

describe("BudgetConfigPage", () => {
  it("renders the budget's persisted name in the name field", () => {
    renderWithContext(<BudgetConfigPage />, buildConfigContext(buildData()));

    expect(nameField().value).toBe("Groceries");
  });

  it("keeps a pending edit when a recalculation re-renders the same budget", () => {
    const data = buildData();
    const { rerenderWithContext } = renderWithContext(
      <BudgetConfigPage />,
      buildConfigContext(data),
    );

    expect(rollOverToggle().checked).toBe(false);

    act(() => {
      fireEvent.click(rollOverToggle());
    });
    expect(rollOverToggle().checked).toBe(true);

    // In the running app an in-page edit calls `calculate.cache.capacityData`,
    // which hands the page a fresh `capacityData` and re-runs the hydration
    // effect. The user's uncommitted toggle must survive it.
    act(() => {
      rerenderWithContext(buildConfigContext(data, { calculations: new Calculations() }));
    });

    expect(rollOverToggle().checked).toBe(true);
  });

  it("re-hydrates from the store when the user navigates to a different budget", () => {
    const data = buildData();
    const other = new Budget({
      budget_id: "other-budget",
      name: "Utilities",
      capacities: [new Capacity({ month: 120 })],
    });
    data.budgets.set("other-budget", other);

    const { rerenderWithContext } = renderWithContext(
      <BudgetConfigPage />,
      buildConfigContext(data),
    );

    act(() => {
      fireEvent.click(rollOverToggle());
    });
    expect(rollOverToggle().checked).toBe(true);

    const { router } = buildRouter(
      PATH.BUDGET_CONFIG,
      new URLSearchParams({ budget_id: "other-budget" }),
    );
    act(() => {
      rerenderWithContext(buildContext({ data, router }));
    });

    expect(nameField().value).toBe("Utilities");
    expect(rollOverToggle().checked).toBe(false);
  });

  it("returns to the Budgets list after deleting a budget, not to its detail page", async () => {
    const data = buildData();
    const store = { data };
    const setData: ContextType["setData"] = (action) => {
      store.data = typeof action === "function" ? action(store.data) : action;
    };
    const { router, calls } = buildRouter(
      PATH.BUDGET_CONFIG,
      new URLSearchParams({ budget_id: BUDGET_ID }),
    );
    window.confirm = () => true;
    fetchStub = stubFetch([{ path: "/api/budget", response: { status: "success" } }]);

    renderWithContext(
      <BudgetConfigPage />,
      buildContext({ data: store.data, setData, router }),
    );

    // The delete button arms on the first click and deletes on the second.
    const deleteButton = screen.getByText("⌫").closest("button") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(deleteButton);
    });
    expect(screen.getByText("Delete")).toBeTruthy();
    await act(async () => {
      fireEvent.click(deleteButton);
    });

    expect(fetchStub.calls.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `DELETE /api/budget?id=${BUDGET_ID}`,
    ]);
    expect(store.data.budgets.has(BUDGET_ID)).toBe(false);

    // The deleted budget's detail page no longer exists — going back would
    // strand the user on its empty body (#834). The list still exists.
    expect(calls.back).toBe(0);
    expect(calls.go).toHaveLength(1);
    expect(calls.go[0].path).toBe(PATH.BUDGETS);
  });

  it("Add New Period adds a period without updating AppContext during render (#798)", () => {
    const data = buildData();
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map((a) => String(a)).join(" "));
    };
    try {
      render(<RealCacheHarness data={data} />);

      // The single default capacity covers all past time, so no dated row yet.
      expect(screen.queryAllByLabelText("Capacity active from date")).toHaveLength(0);

      const addButton = screen.getByText(/Add\s+New\s+Period/).closest("button") as HTMLButtonElement;
      act(() => {
        fireEvent.click(addButton);
      });

      // The new period appears as a dated row — and the click must not have
      // updated AppContext from inside a state updater (React logs "Cannot
      // update a component" when it does).
      expect(screen.getAllByLabelText("Capacity active from date")).toHaveLength(1);
      expect(errors.filter((e) => e.includes("Cannot update a component"))).toEqual([]);
    } finally {
      console.error = originalError;
    }
  });

  it("saving a newly added section keeps the family's capacity periods and ids (#872)", async () => {
    const OCT_2026 = new Date(2026, 9, 1);
    const SECTION_A_ID = "section-a";
    const SECTION_B_ID = "section-b";
    const data = new Data();
    const budget = new Budget({
      budget_id: BUDGET_ID,
      name: "QA",
      capacities: [
        new Capacity({ month: 100, active_from: OCT_2026, capacity_id: "cap-oct" }),
        new Capacity({ month: 500, capacity_id: "cap-base" }),
      ],
    });
    const sectionA = new Section({
      section_id: SECTION_A_ID,
      budget_id: BUDGET_ID,
      name: "A",
      capacities: [
        new Capacity({ month: 50, active_from: OCT_2026, capacity_id: "cap-a-oct" }),
        new Capacity({ month: 50, capacity_id: "cap-a-base" }),
      ],
    });
    // The newly added section has exactly one capacity — the trigger: the
    // old code rebuilt the whole family from the edited entity's periods.
    const sectionB = new Section({
      section_id: SECTION_B_ID,
      budget_id: BUDGET_ID,
      name: "B",
      capacities: [new Capacity({ month: 50, capacity_id: "cap-b-new" })],
    });
    data.budgets.set(BUDGET_ID, budget);
    data.sections.set(SECTION_A_ID, sectionA);
    data.sections.set(SECTION_B_ID, sectionB);
    // `getChildren`/`getParent` traverse the `globalData` singleton, not
    // the context data, so the family has to live in both for the save.
    globalData.budgets.set(BUDGET_ID, budget);
    globalData.sections.set(SECTION_A_ID, sectionA);
    globalData.sections.set(SECTION_B_ID, sectionB);

    const store = { data };
    const setData: ContextType["setData"] = (action) => {
      store.data = typeof action === "function" ? action(store.data) : action;
    };
    const { router } = buildRouter(
      PATH.BUDGET_CONFIG,
      new URLSearchParams({ section_id: SECTION_B_ID }),
    );
    fetchStub = stubFetch([
      { path: "/api/budget", response: { status: "success" } },
      { path: "/api/section", response: { status: "success" } },
    ]);

    try {
      renderWithContext(
        <BudgetConfigPage />,
        buildContext({ data: store.data, setData, router }),
      );

      const saveButton = screen.getByRole("button", { name: /Save/ });
      await act(async () => {
        fireEvent.click(saveButton);
      });

      expect(fetchStub.calls.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        "POST /api/budget",
        "POST /api/section",
        "POST /api/section",
      ]);

      // The budget keeps both periods, with the same rows — no silent
      // deletion, no re-minted ids — and still reads 100 in October.
      const storedBudget = store.data.budgets.get(BUDGET_ID);
      expect(storedBudget?.capacities.map((c) => c.capacity_id)).toEqual([
        "cap-oct",
        "cap-base",
      ]);
      expect(storedBudget?.capacities.map((c) => c.month)).toEqual([100, 500]);
      expect(storedBudget?.getActiveAmount(new Date(2026, 9, 15), "month")).toBe(100);
      // The untouched sibling keeps its periods and ids too.
      const storedA = store.data.sections.get(SECTION_A_ID);
      expect(storedA?.capacities.map((c) => c.capacity_id)).toEqual([
        "cap-a-oct",
        "cap-a-base",
      ]);
      expect(storedA?.capacities.map((c) => c.month)).toEqual([50, 50]);
      // The new section inherits the family's periods: its undated row
      // keeps its id, and the October row is new (fresh id).
      const storedB = store.data.sections.get(SECTION_B_ID);
      expect(storedB?.capacities.map((c) => c.month)).toEqual([50, 50]);
      expect(storedB?.capacities[1].capacity_id).toBe("cap-b-new");
      expect(storedB?.capacities[0].capacity_id).not.toBe("cap-b-new");
      expect(storedB?.capacities[0].capacity_id).toBeTruthy();
    } finally {
      globalData.budgets = new BudgetDictionary();
      globalData.sections = new SectionDictionary();
      globalData.categories = new CategoryDictionary();
    }
  });

  it("toggling sync on a budget cascades is_synced onto its sections", async () => {
    const SECTION_A_ID = "section-a";
    const SECTION_B_ID = "section-b";
    const CATEGORY_ID = "category-a1";
    const data = new Data();
    const budget = new Budget({
      budget_id: BUDGET_ID,
      name: "QA",
      capacities: [new Capacity({ month: 1200 })],
    });
    const sectionA = new Section({
      section_id: SECTION_A_ID,
      budget_id: BUDGET_ID,
      name: "A",
      capacities: [new Capacity({ month: 500 })],
    });
    const sectionB = new Section({
      section_id: SECTION_B_ID,
      budget_id: BUDGET_ID,
      name: "B",
      capacities: [new Capacity({ month: 500 })],
    });
    const category = new Category({
      category_id: CATEGORY_ID,
      section_id: SECTION_A_ID,
      name: "A1",
      capacities: [new Capacity({ month: 300 })],
    });
    data.budgets.set(BUDGET_ID, budget);
    data.sections.set(SECTION_A_ID, sectionA);
    data.sections.set(SECTION_B_ID, sectionB);
    data.categories.set(CATEGORY_ID, category);
    // `getChildren`/`getParent` traverse the `globalData` singleton, not
    // the context data, so the family has to live in both for the save.
    globalData.budgets.set(BUDGET_ID, budget);
    globalData.sections.set(SECTION_A_ID, sectionA);
    globalData.sections.set(SECTION_B_ID, sectionB);
    globalData.categories.set(CATEGORY_ID, category);

    const store = { data };
    const setData: ContextType["setData"] = (action) => {
      store.data = typeof action === "function" ? action(store.data) : action;
    };
    const { router } = buildRouter(
      PATH.BUDGET_CONFIG,
      new URLSearchParams({ budget_id: BUDGET_ID }),
    );
    fetchStub = stubFetch([
      { path: "/api/budget", response: { status: "success" } },
      { path: "/api/section", response: { status: "success" } },
      { path: "/api/category", response: { status: "success" } },
    ]);

    try {
      renderWithContext(
        <BudgetConfigPage />,
        buildContext({ data: store.data, setData, router }),
      );

      const syncToggle = () => {
        const row = screen.getByText("Sync with children").closest(".row");
        return row?.querySelector('input[type="checkbox"]') as HTMLInputElement;
      };
      expect(syncToggle().checked).toBe(false);
      act(() => {
        fireEvent.click(syncToggle());
      });
      expect(syncToggle().checked).toBe(true);

      const saveButton = screen.getByRole("button", { name: /Save/ });
      await act(async () => {
        fireEvent.click(saveButton);
      });

      expect(fetchStub.calls.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        "POST /api/budget",
        "POST /api/section",
        "POST /api/section",
        "POST /api/category",
      ]);

      // The toggled budget derives its amount from its sections, and the
      // toggle cascades: each section now derives from its categories…
      expect(store.data.budgets.get(BUDGET_ID)?.capacities[0].is_synced).toBe(true);
      const storedA = store.data.sections.get(SECTION_A_ID);
      expect(storedA?.capacities[0].is_synced).toBe(true);
      expect(storedA?.getActiveAmount(new Date(2026, 0, 15), "month")).toBe(300);
      // …while the childless section keeps its stored amount instead of
      // collapsing to zero: a synced entity with no children falls back
      // to its stored amount in Capacity.getActiveAmount.
      const storedB = store.data.sections.get(SECTION_B_ID);
      expect(storedB?.capacities[0].is_synced).toBe(true);
      expect(storedB?.capacities[0].month).toBe(500);
      expect(storedB?.getActiveAmount(new Date(2026, 0, 15), "month")).toBe(500);
      // …and the budget sums the sections' effective amounts: 300 + 500.
      // getChildren/getParent traverse globalData, which still holds the
      // pre-save originals, so point it at the saved dictionaries first —
      // the same state a reload would see — or the budget would sum the
      // originals' stored amounts instead of the cascaded flags.
      globalData.budgets = store.data.budgets;
      globalData.sections = store.data.sections;
      globalData.categories = store.data.categories;
      expect(store.data.budgets.get(BUDGET_ID)?.getActiveAmount(new Date(2026, 0, 15), "month")).toBe(800);
    } finally {
      globalData.budgets = new BudgetDictionary();
      globalData.sections = new SectionDictionary();
      globalData.categories = new CategoryDictionary();
    }
  });

  it("toggling sync on a section marks only that section, not its siblings or budget", async () => {
    const { data, SECTION_A_ID, SECTION_B_ID } = buildSyncFamily();

    const store = { data };
    const setData: ContextType["setData"] = (action) => {
      store.data = typeof action === "function" ? action(store.data) : action;
    };
    const { router } = buildRouter(
      PATH.BUDGET_CONFIG,
      new URLSearchParams({ section_id: SECTION_A_ID }),
    );
    fetchStub = stubSaveEndpoints();

    try {
      renderWithContext(
        <BudgetConfigPage />,
        buildContext({ data: store.data, setData, router }),
      );

      expect(syncToggle().checked).toBe(false);
      act(() => {
        fireEvent.click(syncToggle());
      });
      expect(syncToggle().checked).toBe(true);

      const saveButton = screen.getByRole("button", { name: /Save/ });
      await act(async () => {
        fireEvent.click(saveButton);
      });

      expect(fetchStub.calls.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        "POST /api/budget",
        "POST /api/section",
        "POST /api/section",
        "POST /api/category",
      ]);

      // The toggled section derives its amount from its categories…
      const storedA = store.data.sections.get(SECTION_A_ID);
      expect(storedA?.capacities[0].is_synced).toBe(true);
      expect(storedA?.getActiveAmount(new Date(2026, 0, 15), "month")).toBe(300);
      // …but neither the budget nor the sibling section was cascaded onto.
      expect(store.data.budgets.get(BUDGET_ID)?.capacities[0].is_synced).toBe(false);
      const storedB = store.data.sections.get(SECTION_B_ID);
      expect(storedB?.capacities[0].is_synced).toBe(false);
      expect(storedB?.capacities[0].month).toBe(500);
    } finally {
      resetGlobalData();
    }
  });

  it("toggling infinite sync on a budget marks only the budget, not its sections", async () => {
    const { data, SECTION_A_ID, SECTION_B_ID, CATEGORY_ID } = buildSyncFamily();

    const store = { data };
    const setData: ContextType["setData"] = (action) => {
      store.data = typeof action === "function" ? action(store.data) : action;
    };
    const { router } = buildRouter(
      PATH.BUDGET_CONFIG,
      new URLSearchParams({ budget_id: BUDGET_ID }),
    );
    fetchStub = stubSaveEndpoints();

    try {
      renderWithContext(
        <BudgetConfigPage />,
        buildContext({ data: store.data, setData, router }),
      );

      // Infinite first: the "Limited budget" toggle disables once sync is on.
      expect(limitedToggle().checked).toBe(true);
      expect(syncToggle().checked).toBe(false);
      act(() => {
        fireEvent.click(limitedToggle());
      });
      expect(limitedToggle().checked).toBe(false);
      act(() => {
        fireEvent.click(syncToggle());
      });
      expect(syncToggle().checked).toBe(true);

      const saveButton = screen.getByRole("button", { name: /Save/ });
      await act(async () => {
        fireEvent.click(saveButton);
      });

      // Only the toggled budget is written — the infinite path no longer
      // rewrites every section and category in the family.
      expect(fetchStub.calls.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        "POST /api/budget",
      ]);

      // The toggled budget is infinite and synced…
      const storedBudget = store.data.budgets.get(BUDGET_ID);
      expect(storedBudget?.capacities[0].is_synced).toBe(true);
      expect(storedBudget?.capacities[0].month).toBe(MAX_FLOAT);
      // …but neither section was cascaded onto: each keeps its own mode and
      // stored amount, so the childless section keeps resolving to 500.
      const storedA = store.data.sections.get(SECTION_A_ID);
      expect(storedA?.capacities[0].is_synced).toBe(false);
      expect(storedA?.capacities[0].month).toBe(500);
      const storedB = store.data.sections.get(SECTION_B_ID);
      expect(storedB?.capacities[0].is_synced).toBe(false);
      expect(storedB?.capacities[0].month).toBe(500);
      expect(storedB?.getActiveAmount(new Date(2026, 0, 15), "month")).toBe(500);
      expect(store.data.categories.get(CATEGORY_ID)?.capacities[0].month).toBe(300);
      // …and the budget sums the sections' effective amounts.
      expect(storedBudget?.getActiveAmount(new Date(2026, 0, 15), "month")).toBe(1000);
    } finally {
      resetGlobalData();
    }
  });

  it("toggling infinite sync on a section marks only that section, not its siblings", async () => {
    const { data, SECTION_A_ID, SECTION_B_ID, CATEGORY_ID } = buildSyncFamily();

    const store = { data };
    const setData: ContextType["setData"] = (action) => {
      store.data = typeof action === "function" ? action(store.data) : action;
    };
    const { router } = buildRouter(
      PATH.BUDGET_CONFIG,
      new URLSearchParams({ section_id: SECTION_A_ID }),
    );
    fetchStub = stubSaveEndpoints();

    try {
      renderWithContext(
        <BudgetConfigPage />,
        buildContext({ data: store.data, setData, router }),
      );

      expect(limitedToggle().checked).toBe(true);
      expect(syncToggle().checked).toBe(false);
      act(() => {
        fireEvent.click(limitedToggle());
      });
      act(() => {
        fireEvent.click(syncToggle());
      });

      const saveButton = screen.getByRole("button", { name: /Save/ });
      await act(async () => {
        fireEvent.click(saveButton);
      });

      expect(fetchStub.calls.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        "POST /api/section",
      ]);

      // The toggled section is infinite and synced, and derives from its
      // categories as they are…
      const storedA = store.data.sections.get(SECTION_A_ID);
      expect(storedA?.capacities[0].is_synced).toBe(true);
      expect(storedA?.capacities[0].month).toBe(MAX_FLOAT);
      expect(storedA?.getActiveAmount(new Date(2026, 0, 15), "month")).toBe(300);
      expect(store.data.categories.get(CATEGORY_ID)?.capacities[0].month).toBe(300);
      // …but neither the budget nor the sibling section was cascaded onto.
      expect(store.data.budgets.get(BUDGET_ID)?.capacities[0].is_synced).toBe(false);
      const storedB = store.data.sections.get(SECTION_B_ID);
      expect(storedB?.capacities[0].is_synced).toBe(false);
      expect(storedB?.capacities[0].month).toBe(500);
    } finally {
      resetGlobalData();
    }
  });
});
