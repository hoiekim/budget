import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { Budget, ContextType, Data, PATH } from "client";
import { buildContext, buildRouter, renderWithContext, resetDom, stubFetch } from "test-render";
import { BudgetsPage } from ".";

let fetchStub: ReturnType<typeof stubFetch> | undefined;

afterEach(() => {
  // `cleanup()` first: unmount effects run inside it, and a request one of them
  // fires has to land on the stub rather than escape to a real one.
  cleanup();
  fetchStub?.restore();
  fetchStub = undefined;
  resetDom();
});

/**
 * `setData` in the running app is a `useState` setter. Pages call it with an
 * updater, so a test needs to apply that updater and keep the result to see
 * what the page actually stored.
 */
const buildStore = () => {
  const store = { data: new Data() };
  const setData: ContextType["setData"] = (action) => {
    store.data = typeof action === "function" ? action(store.data) : action;
  };
  return { store, setData };
};

const clickAddBudget = async () => {
  const button = screen.getByRole("button", { name: /^Add.Budget$/ });
  await act(async () => {
    fireEvent.click(button);
  });
};

describe("BudgetsPage — Add Budget", () => {
  it("stores the budget under the id the server assigned and opens its config page", async () => {
    const { store, setData } = buildStore();
    const { router, calls } = buildRouter(PATH.BUDGETS);
    fetchStub = stubFetch([
      {
        path: "/api/new-budget",
        response: {
          status: "success",
          body: {
            budget: {
              budget_id: "server-side-id",
              name: "New Budget",
              capacities: [],
              roll_over: false,
              iso_currency_code: "USD",
            },
          },
        },
      },
    ]);

    renderWithContext(<BudgetsPage />, buildContext({ data: store.data, setData, router }));
    await clickAddBudget();

    expect(fetchStub.calls.requests.map((r) => r.url)).toEqual(["/api/new-budget"]);

    const stored = store.data.budgets.get("server-side-id");
    expect(stored).toBeInstanceOf(Budget);
    expect(stored?.budget_id).toBe("server-side-id");
    expect(Array.from(store.data.budgets.keys())).toEqual(["server-side-id"]);

    expect(calls.go).toHaveLength(1);
    expect(calls.go[0].path).toBe(PATH.BUDGET_CONFIG);
    expect(calls.go[0].params?.get("budget_id")).toBe("server-side-id");
  });

  it("neither stores a budget nor navigates when the server returns no budget", async () => {
    const { store, setData } = buildStore();
    const { router, calls } = buildRouter(PATH.BUDGETS);
    fetchStub = stubFetch([
      { path: "/api/new-budget", response: { status: "error", message: "no user" } },
    ]);

    renderWithContext(<BudgetsPage />, buildContext({ data: store.data, setData, router }));
    await clickAddBudget();

    expect(fetchStub.calls.requests).toHaveLength(1);
    expect(store.data.budgets.size).toBe(0);
    expect(calls.go).toHaveLength(0);
  });
});
