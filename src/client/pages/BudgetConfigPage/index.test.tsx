import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import {
  Budget,
  BudgetDictionary,
  Calculations,
  Capacity,
  CategoryDictionary,
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

const rollOverToggle = () => {
  const row = screen.getByText("Rolls over to the next period").closest(".row");
  return row?.querySelector('input[type="checkbox"]') as HTMLInputElement;
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
});
