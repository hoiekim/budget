import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { Budget, Capacity, Data, PATH } from "client";
import { buildContext, buildRouter, renderWithContext, resetDom } from "test-render";
import { BudgetDetailPage } from ".";

afterEach(() => {
  cleanup();
  resetDom();
});

const MISSING_ID = "budget-that-does-not-exist";

const renderDetailPage = (data: Data, budgetId: string) => {
  const { router, calls } = buildRouter(
    PATH.BUDGET_DETAIL,
    new URLSearchParams({ budget_id: budgetId }),
  );
  renderWithContext(<BudgetDetailPage />, buildContext({ data, router }));
  return { calls };
};

describe("BudgetDetailPage — missing budget", () => {
  it("renders a not-found state with a way back instead of an empty body", async () => {
    const { calls } = renderDetailPage(new Data(), MISSING_ID);

    expect(screen.getByText("This budget no longer exists.")).toBeTruthy();
    // The empty wrapper the page used to render has no interactive content.
    expect(document.querySelector(".BudgetDetailPage")?.children.length).toBe(1);

    const backButton = screen.getByRole("button", { name: "Back to Budgets" });
    await act(async () => {
      fireEvent.click(backButton);
    });

    expect(calls.go).toHaveLength(1);
    expect(calls.go[0].path).toBe(PATH.BUDGETS);
  });

  it("does not show the not-found state for a budget that exists", () => {
    const data = new Data();
    data.budgets.set(
      "budget-under-view",
      new Budget({
        budget_id: "budget-under-view",
        name: "Groceries",
        capacities: [new Capacity({ month: 500 })],
      }),
    );

    renderDetailPage(data, "budget-under-view");

    expect(screen.queryByText("This budget no longer exists.")).toBeNull();
    expect(document.querySelector(".BudgetDetail")).toBeTruthy();
  });
});
