// Run with: bun test --preload ./scripts/test-preload.ts index.test.tsx
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup } from "@testing-library/react";
import { Account, Chart, Data, FlowChart, FlowChartConfiguration } from "client";
import { ChartType } from "common";
import { buildContext, renderWithContext, resetDom } from "test-render";
import { Transaction } from "../../lib/models/Transaction";
import { FlowChartRow } from ".";

afterEach(() => {
  cleanup();
  resetDom();
});

const ACC_ID = "acc-1";
// `buildContext` pins viewDate to January 2026, so every fixture transaction
// is dated inside that month.
const DATE = "2026-01-10";

const buildChart = () =>
  new Chart({
    chart_id: "chart-1",
    name: "Flow",
    type: ChartType.FLOW,
    configuration: new FlowChartConfiguration({ account_ids: [ACC_ID], budget_ids: [] }),
  }) as unknown as FlowChart;

const buildData = (transactions: { id: string; amount: number }[]) => {
  const data = new Data();
  data.accounts.set(ACC_ID, new Account({ account_id: ACC_ID, name: "Checking" } as never));
  for (const { id, amount } of transactions) {
    const tx = new Transaction({
      account_id: ACC_ID,
      transaction_id: id,
      amount,
      date: DATE,
      label: {},
    });
    data.transactions.set(tx.id, tx);
  }
  return data;
};

const renderRow = (data: Data) => {
  const { container } = renderWithContext(<FlowChartRow chart={buildChart()} />, buildContext({ data }));
  return container;
};

/** The In/Out row, then the diff row — [deficit cell, surplus cell]. */
const diffCells = (container: HTMLElement) => {
  const rows = container.querySelectorAll(".FlowChartRow table tbody tr");
  expect(rows.length).toBe(4);
  return rows[3].querySelectorAll("td");
};

describe("FlowChartRow — In/Out table diff row", () => {
  it("a zero-activity period fills neither the deficit nor the surplus cell", () => {
    const container = renderRow(buildData([]));

    // The period really rendered zero: the In/Out row reads $ 0.00 / $ 0.00
    // (via `$&nbsp;`, so the space is a non-breaking one), so the two blank
    // cells below it are the fix, not an empty render.
    const rows = container.querySelectorAll(".FlowChartRow table tbody tr");
    expect(rows[1].textContent).toContain("$\u00a00.00");
    const [deficit, surplus] = diffCells(container);
    expect(deficit.textContent).toBe("");
    expect(surplus.textContent).toBe("");
  });

  it("equal income and expense fill neither cell — zero is break-even, not a deficit", () => {
    const container = renderRow(
      buildData([
        { id: "tx-in", amount: -100 },
        { id: "tx-out", amount: 100 },
      ]),
    );
    const [deficit, surplus] = diffCells(container);
    expect(deficit.textContent).toBe("");
    expect(surplus.textContent).toBe("");
  });

  it("a deficit fills only the red cell, with the shortfall amount", () => {
    const container = renderRow(buildData([{ id: "tx-out", amount: 100 }]));
    const [deficit, surplus] = diffCells(container);
    expect(deficit.textContent).toBe("$ 100.00");
    expect(surplus.textContent).toBe("");
  });

  it("a surplus fills only the green cell, with the excess amount", () => {
    const container = renderRow(buildData([{ id: "tx-in", amount: -100 }]));
    const [deficit, surplus] = diffCells(container);
    expect(deficit.textContent).toBe("");
    expect(surplus.textContent).toBe("$ 100.00");
  });
});
