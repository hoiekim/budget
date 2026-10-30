import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { Budget, Calculations, Capacity, ContextType, Data, PATH } from "client";
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
});
