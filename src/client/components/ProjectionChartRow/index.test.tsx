// Run with: bun test --preload ./scripts/test-preload.ts index.test.tsx
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup } from "@testing-library/react";
import {
  Account,
  AmountInTime,
  Budget,
  Calculations,
  Capacity,
  Chart,
  Data,
  ProjectionChart,
  ProjectionChartConfiguration,
  ScreenType,
} from "client";
import { ChartType } from "common";
import { buildContext, renderWithContext, resetDom } from "test-render";
import { ProjectionChartRow } from ".";

afterEach(() => {
  cleanup();
  resetDom();
});

const ACC_ID = "acc-1";

const buildChart = (
  account_ids: string[],
  configuration?: Partial<ProjectionChartConfiguration>,
) =>
  new Chart({
    chart_id: "chart-1",
    name: "Retirement",
    type: ChartType.PROJECTION,
    configuration: new ProjectionChartConfiguration({ account_ids, ...configuration }),
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

const renderRow = (
  data: Data,
  account_ids: string[],
  options?: {
    calculations?: Calculations;
    configuration?: Partial<ProjectionChartConfiguration>;
    screenType?: ScreenType;
  },
) => {
  const { container } = renderWithContext(
    <ProjectionChartRow chart={buildChart(account_ids, options?.configuration)} />,
    buildContext({
      data,
      ...(options?.calculations ? { calculations: options.calculations } : {}),
      ...(options?.screenType !== undefined ? { screenType: options.screenType } : {}),
    }),
  );
  return container;
};

describe("ProjectionChartRow — scenario labels", () => {
  it("labels each table row with its scenario instead of colour alone", () => {
    // A nonzero balance makes both projection rows render: each row is
    // gated on its retire amount, so a zero balance hides it.
    const calculations = new Calculations();
    calculations.balanceData.set(ACC_ID, new Date(), 100000);
    const container = renderRow(buildData({}), [ACC_ID], {
      calculations,
      configuration: {
        initial_saving: new AmountInTime({ amount: 100000, amountAsOf: new Date() }),
      },
    });

    const table = container.querySelector(".ProjectionChartRow table");
    expect(table).not.toBeNull();
    expect(table!.querySelector("thead th.scenario")?.textContent).toBe("Scenario");
    const labels = [...table!.querySelectorAll("td.scenario span.scenarioName")].map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(["Now", "Trajectory", "Plan"]);
    // the swatch stays as a visual aid beside the text
    expect(table!.querySelectorAll("td.scenario div.label").length).toBe(3);
  });
});

describe("ProjectionChartRow — narrow screens and narrow cells", () => {
  const renderTable = (screenType: ScreenType) => {
    const calculations = new Calculations();
    calculations.balanceData.set(ACC_ID, new Date(), 1_100_100);
    const container = renderRow(buildData({}), [ACC_ID], {
      calculations,
      screenType,
      configuration: {
        initial_saving: new AmountInTime({ amount: 1_100_100, amountAsOf: new Date() }),
      },
    });
    return container.querySelector(".ProjectionChartRow table")!;
  };
  const hiddenNames = (table: Element) =>
    [...table.querySelectorAll(".scenarioName, th.scenario span")].map((el) =>
      el.classList.contains("visuallyHidden"),
    );
  const nowRowCells = (table: Element) =>
    [...table.querySelectorAll("tbody tr:first-child td")].map((td) => td.textContent);

  it("hides the scenario names on a narrow screen but keeps the color chips", () => {
    const table = renderTable(ScreenType.Narrow);
    // header + the three row names, all still in the DOM for screen readers
    expect(hiddenNames(table)).toEqual([true, true, true, true]);
    expect(table.querySelectorAll("td.scenario div.label").length).toBe(3);
  });

  it("shows the scenario names on wider screens", () => {
    for (const screenType of [ScreenType.Medium, ScreenType.Wide]) {
      const table = renderTable(screenType);
      expect(hiddenNames(table)).toEqual([false, false, false, false]);
      cleanup();
    }
  });

  it("shows full amounts while the table fits", () => {
    const [, , saved] = nowRowCells(renderTable(ScreenType.Narrow));
    expect(saved).toBe("$ 1,100,100");
  });

  it("switches every amount to the compact form when the table is wider than its container", () => {
    const tableWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
    const containerWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    try {
      Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
        configurable: true,
        get() {
          return this.tagName === "TABLE" ? 400 : 0;
        },
      });
      Object.defineProperty(HTMLElement.prototype, "clientWidth", {
        configurable: true,
        get: () => 320,
      });
      const [, date, saved, payout] = nowRowCells(renderTable(ScreenType.Narrow));
      expect(saved).toBe("$1.1M");
      expect(payout).toMatch(/^\$[\d.]+K$/);
      // dates have no compact form
      expect(date).toMatch(/^\d{4}-\d{2}$/);
    } finally {
      // Put back what was there; where the getter was inherited, drop the override.
      const restore = (name: string, own: PropertyDescriptor | undefined) => {
        if (own) Object.defineProperty(HTMLElement.prototype, name, own);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
      };
      restore("scrollWidth", tableWidth);
      restore("clientWidth", containerWidth);
    }
  });
});

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

describe("ProjectionChartRow — auto goal configuration", () => {
  const scenarioLabels = (container: HTMLElement) =>
    [...container.querySelectorAll("td.scenario span.scenarioName")].map((el) => el.textContent);

  it("projects against the inferred goal instead of the stored manual one", () => {
    const calculations = new Calculations();
    calculations.balanceData.set(ACC_ID, new Date(), 100000);
    const data = buildData({});
    data.budgets.set(
      "rent",
      new Budget({ budget_id: "rent", name: "Rent", capacities: [new Capacity({ month: 2000 })] }),
    );
    data.inflation = {
      year_over_year_inflation: 1.025,
      from: "1996-09",
      to: "2026-09",
      series_id: "CUUR0000SA0",
    };
    const configuration = {
      initial_saving: new AmountInTime({ amount: 100000, amountAsOf: new Date() }),
      // A stored goal no saving can reach: only the "Now" row renders against it.
      living_cost: new AmountInTime({ amount: 1e12, amountAsOf: new Date() }),
      budget_ids: ["rent"],
    };

    const manual = renderRow(data, [ACC_ID], { calculations, configuration });
    expect(scenarioLabels(manual)).toEqual(["Now"]);
    cleanup();

    const auto = renderRow(data, [ACC_ID], {
      calculations,
      configuration: { ...configuration, auto_goal_config: true },
    });
    expect(scenarioLabels(auto)).toEqual(["Now", "Trajectory", "Plan"]);
  });
});
