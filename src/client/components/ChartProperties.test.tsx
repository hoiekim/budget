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
  BalanceChart,
  BalanceChartConfiguration,
  Chart,
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
