import { afterEach, describe, expect, it } from "bun:test";
import { useMemo, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Budget, Calculations, Capacity, Context, ContextType, Data, PATH } from "client";
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
});
