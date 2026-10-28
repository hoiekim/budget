// Run with: bun test --preload ./scripts/test-preload.ts index.test.tsx
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup } from "@testing-library/react";
import { Account, Chart, Data, ProjectionChart, ProjectionChartConfiguration } from "client";
import { ChartType } from "common";
import { buildContext, renderWithContext, resetDom } from "test-render";
import { ProjectionChartRow } from ".";

afterEach(() => {
  cleanup();
  resetDom();
});

const ACC_ID = "acc-1";

const buildChart = (account_ids: string[]) =>
  new Chart({
    chart_id: "chart-1",
    name: "Retirement",
    type: ChartType.PROJECTION,
    configuration: new ProjectionChartConfiguration({ account_ids }),
  }) as unknown as ProjectionChart;

const buildData = ({ hidden = false, deleted = false }: { hidden?: boolean; deleted?: boolean }) => {
  const data = new Data();
  if (!deleted) {
    data.accounts.set(
      ACC_ID,
      new Account({ account_id: ACC_ID, name: "Savings", hide: hidden } as never),
    );
  }
  return data;
};

const renderRow = (data: Data, account_ids: string[]) => {
  const { container } = renderWithContext(
    <ProjectionChartRow chart={buildChart(account_ids)} />,
    buildContext({ data }),
  );
  return container;
};

describe("ProjectionChartRow — empty selection", () => {
  it("renders the empty state instead of throwing when every referenced account is hidden", () => {
    // The stored account_ids still reference the account but the graphed
    // list drops hidden accounts, so the history sequence is [] and the
    // old code reached `new Array(sequence.length - 1)` = `new Array(-1)`,
    // a RangeError that the app-root ErrorBoundary turned into a
    // whole-app "Something went wrong".
    const container = renderRow(buildData({ hidden: true }), [ACC_ID]);

    expect(container.querySelector(".ProjectionChartRow")).not.toBeNull();
    // the projection table only renders on the graphed path
    expect(container.querySelector(".ProjectionChartRow table")).toBeNull();
  });

  it("renders the empty state instead of throwing when every referenced account is deleted", () => {
    // A deleted account leaves a stale id in account_ids that resolves to
    // no account at all — same empty selection, same crash pre-fix.
    const container = renderRow(buildData({ deleted: true }), [ACC_ID]);

    expect(container.querySelector(".ProjectionChartRow")).not.toBeNull();
    expect(container.querySelector(".ProjectionChartRow table")).toBeNull();
  });

  it("still renders the empty state when no accounts are selected at all", () => {
    const container = renderRow(buildData({}), []);

    expect(container.querySelector(".ProjectionChartRow")).not.toBeNull();
    expect(container.querySelector(".ProjectionChartRow table")).toBeNull();
  });
});
