import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { ChartType, US_STATE_NAMES } from "common";
import {
  AmountInTime,
  Budget,
  Capacity,
  Chart,
  Data,
  PATH,
  ProjectionChart,
  ProjectionChartConfiguration,
  resetAverageInflationCache,
  Transaction,
} from "client";
import { buildContext, buildRouter, renderWithContext, resetDom, stubFetch } from "test-render";
import { ProjectionChartProperties } from "./ProjectionChartProperties";

let fetchStub: ReturnType<typeof stubFetch> | undefined;

beforeEach(() => resetAverageInflationCache());

afterEach(() => {
  cleanup();
  resetDom();
  fetchStub?.restore();
  fetchStub = undefined;
});

const CHART_ID = "chart-1";

const INFLATION = {
  year_over_year_inflation: 1.025,
  from: "1996-09",
  to: "2026-09",
  series_id: "CUUR0000SA0",
};

const buildChart = (overrides: Partial<ProjectionChartConfiguration> = {}) =>
  new Chart({
    chart_id: CHART_ID,
    name: "Retirement",
    type: ChartType.PROJECTION,
    configuration: new ProjectionChartConfiguration({
      living_cost: new AmountInTime({ amount: 4000, amountAsOf: new Date(2024, 0, 1), taxRate: 0.3 }),
      year_over_year_inflation: 1.038,
      ...overrides,
    }),
  }) as unknown as ProjectionChart;

const recentDay = () => {
  const d = new Date();
  d.setDate(d.getDate() - 10);
  return d.toISOString().slice(0, 10);
};

const buildData = (chart: ProjectionChart) => {
  const data = new Data();
  data.charts.set(CHART_ID, chart as unknown as Chart);
  data.budgets.set(
    "rent",
    new Budget({ budget_id: "rent", name: "Rent", capacities: [new Capacity({ month: 2000 })] }),
  );
  data.budgets.set(
    "food",
    new Budget({ budget_id: "food", name: "Food", capacities: [new Capacity({ month: 600 })] }),
  );
  for (let i = 0; i < 3; i++) {
    const t = new Transaction({ account_id: "acc", transaction_id: `t-${i}`, date: recentDay() });
    t.location = { ...t.location, region: "TX", country: "US" };
    data.transactions.set(t.transaction_id, t);
  }
  return data;
};

const render = (chart: ProjectionChart) => {
  const { router, calls } = buildRouter(
    PATH.CHART_DETAIL,
    new URLSearchParams({ chart_id: CHART_ID }),
  );
  renderWithContext(
    <ProjectionChartProperties chart={chart} />,
    buildContext({ data: buildData(chart), router }),
  );
  return calls;
};

const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe("ProjectionChartProperties — goal configuration", () => {
  it("in manual mode shows the stored values, stays editable, and asks the server nothing", () => {
    fetchStub = stubFetch([]);
    render(buildChart());

    expect(input("Living cost").value).toBe("4,000");
    expect(input("Living cost").disabled).toBe(false);
    expect(input("Tax rate").value).toBe("30.00");
    expect(input("Year over year inflation").value).toBe("3.80");
    expect(screen.queryByText("Tax")).toBeNull();
    expect(fetchStub.calls.requests).toEqual([]);
  });

  it("in auto mode shows inferred values from budgets, CPI, and transaction state", async () => {
    fetchStub = stubFetch([
      { path: "/api/inflation", response: { status: "success", body: INFLATION } },
    ]);
    render(buildChart({ auto_goal_config: true, budget_ids: ["rent", "food"] }));

    await waitFor(() => expect(input("Year over year inflation").value).toBe("2.50"));
    expect(input("Living cost").value).toBe("2,600");
    expect(input("Living cost").disabled).toBe(true);
    expect(input("Tax rate").disabled).toBe(true);
    expect(input("Tax rate").value).not.toBe("30.00");
    expect(screen.getByText(US_STATE_NAMES.TX)).toBeTruthy();
    expect(screen.getByText("CPI 1996-09 – 2026-09")).toBeTruthy();
    expect(screen.getByText("Living cost from 2 budgets")).toBeTruthy();
  });

  it("says so when CPI history has not been collected yet", async () => {
    fetchStub = stubFetch([{ path: "/api/inflation", response: { status: "success", body: null } }]);
    render(buildChart({ auto_goal_config: true }));

    await waitFor(() =>
      expect(screen.getByText("Not collected yet (using manual rate)")).toBeTruthy(),
    );
    expect(input("Year over year inflation").value).toBe("3.80");
    expect(screen.getByText("Select budgets for living cost")).toBeTruthy();
  });

  it("opens the budget picker from the living-cost row", async () => {
    fetchStub = stubFetch([
      { path: "/api/inflation", response: { status: "success", body: INFLATION } },
    ]);
    const calls = render(buildChart({ auto_goal_config: true }));
    await waitFor(() => expect(screen.getByText("CPI 1996-09 – 2026-09")).toBeTruthy());

    act(() => {
      fireEvent.click(screen.getByText("Select budgets for living cost"));
    });
    expect(calls.go).toHaveLength(1);
    expect(calls.go[0].path).toBe(PATH.CHART_ACCOUNTS);
    expect(calls.go[0].params?.get("chart_id")).toBe(CHART_ID);
  });

  it("turning auto on saves the flag on the chart", async () => {
    fetchStub = stubFetch([
      { path: "/api/inflation", response: { status: "success", body: INFLATION } },
      { path: "/api/chart", response: { status: "success" } },
    ]);
    render(buildChart());

    const toggle = screen.getByLabelText(
      "Infer goal configuration automatically",
    ) as HTMLInputElement;
    act(() => {
      fireEvent.click(toggle);
    });

    await waitFor(() =>
      expect(fetchStub!.calls.requests.some((r) => r.url.includes("/api/chart"))).toBe(true),
    );
    expect(input("Living cost").disabled).toBe(true);
    await waitFor(() => expect(screen.getByText("CPI 1996-09 – 2026-09")).toBeTruthy());
  });
});
