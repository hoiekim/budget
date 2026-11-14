import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { ChartType } from "common";
import { Budget, Capacity, Chart, Data, PATH, ProjectionChartConfiguration } from "client";
import { buildContext, buildRouter, renderWithContext, resetDom, stubFetch } from "test-render";
import { ChartAccountsPage } from "./ChartAccountsPage";

let fetchStub: ReturnType<typeof stubFetch> | undefined;

afterEach(() => {
  cleanup();
  resetDom();
  fetchStub?.restore();
  fetchStub = undefined;
});

const CHART_ID = "chart-1";

const render = (budget_ids: string[]) => {
  const data = new Data();
  data.charts.set(
    CHART_ID,
    new Chart({
      chart_id: CHART_ID,
      type: ChartType.PROJECTION,
      configuration: new ProjectionChartConfiguration({ budget_ids }),
    }),
  );
  data.budgets.set(
    "rent",
    new Budget({ budget_id: "rent", name: "Rent", capacities: [new Capacity({ month: 2000 })] }),
  );
  const { router } = buildRouter(PATH.CHART_ACCOUNTS, new URLSearchParams({ chart_id: CHART_ID }));
  renderWithContext(<ChartAccountsPage />, buildContext({ data, router }));
};

const rentToggle = () =>
  screen.getByText("Rent").closest(".row")!.querySelector("input") as HTMLInputElement;

describe("ChartAccountsPage — projection chart", () => {
  it("offers the budgets that make up the inferred living cost", () => {
    render(["rent"]);
    expect(screen.getByText("Select budgets for living cost")).toBeTruthy();
    expect(rentToggle().checked).toBe(true);
  });

  it("saves a toggled budget into the projection configuration", async () => {
    fetchStub = stubFetch([{ path: "/api/chart", response: { status: "success" } }]);
    render([]);

    act(() => {
      fireEvent.click(rentToggle());
    });

    await waitFor(() => expect(fetchStub!.calls.requests).toHaveLength(1));
    expect(fetchStub.calls.requests[0]).toMatchObject({ method: "POST" });
  });
});
