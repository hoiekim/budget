// The chart name input's accessible name, on all three chart-properties
// shells. The 2026-03 aria-label fix landed on Balance and Projection
// but missed Flow, and no test named all three — a test naming only two
// would have passed throughout. So this test names all three, one case
// per shell. (Refs #817; the shell extraction itself is deliberately
// not in this change.)
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, screen } from "@testing-library/react";
import { ChartType } from "common";
import {
  Account,
  BalanceChart,
  BalanceChartConfiguration,
  Budget,
  Chart,
  Data,
  FlowChart,
  FlowChartConfiguration,
  ProjectionChart,
  ProjectionChartConfiguration,
} from "client";
import { buildContext, renderWithContext, resetDom } from "test-render";
import { BalanceChartProperties } from "./BalanceChartProperties";
import { FlowChartProperties } from "./FlowChartProperties";
import { ProjectionChartProperties } from "./ProjectionChartProperties";

afterEach(() => {
  cleanup();
  resetDom();
});

const balance = new Chart({
  name: "Balance chart",
  type: ChartType.BALANCE,
  configuration: new BalanceChartConfiguration(),
}) as BalanceChart;
const projection = new Chart({
  name: "Projection chart",
  type: ChartType.PROJECTION,
  configuration: new ProjectionChartConfiguration(),
}) as ProjectionChart;
const flow = new Chart({
  name: "Flow chart",
  type: ChartType.FLOW,
  configuration: new FlowChartConfiguration(),
}) as FlowChart;

const cases = [
  { label: "Balance", name: balance.name, element: <BalanceChartProperties chart={balance} /> },
  {
    label: "Projection",
    name: projection.name,
    element: <ProjectionChartProperties chart={projection} />,
  },
  { label: "Flow", name: flow.name, element: <FlowChartProperties chart={flow} /> },
];

describe("chart-properties name input", () => {
  for (const { label, name, element } of cases) {
    test(`${label}: the name input has the accessible name "Chart name"`, () => {
      renderWithContext(element, buildContext());
      const input = screen.getByLabelText("Chart name") as HTMLInputElement;
      expect(input.value).toBe(name);
    });
  }
});

describe("chart-properties selection row", () => {
  const data = new Data();
  data.accounts.set("acc", new Account({ account_id: "acc", name: "Savings" } as never));
  data.accounts.set("old", new Account({ account_id: "old", name: "Closed", hide: true } as never));
  data.budgets.set("rent", new Budget({ budget_id: "rent", name: "Rent" }));
  data.budgets.set("food", new Budget({ budget_id: "food", name: "Food" }));
  // A hidden account and ids whose account or budget was deleted aren't counted.
  const selection = {
    account_ids: ["acc", "old", "deleted-account"],
    budget_ids: ["rent", "food", "deleted-budget"],
  };

  const selectionCases = [
    {
      label: "Balance",
      element: (
        <BalanceChartProperties
          chart={
            new Chart({
              type: ChartType.BALANCE,
              configuration: new BalanceChartConfiguration(selection),
            }) as BalanceChart
          }
        />
      ),
    },
    {
      label: "Projection",
      element: (
        <ProjectionChartProperties
          chart={
            new Chart({
              type: ChartType.PROJECTION,
              configuration: new ProjectionChartConfiguration(selection),
            }) as ProjectionChart
          }
        />
      ),
    },
  ];

  for (const { label, element } of selectionCases) {
    test(`${label}: counts accounts and budgets separately under Selected Accounts & Budgets`, () => {
      renderWithContext(element, buildContext({ data }));
      expect(screen.getByText(/^Selected.Accounts.&.Budgets$/)).toBeTruthy();
      expect(screen.getByText("3 selected (1 account & 2 budgets)")).toBeTruthy();
    });
  }
});
