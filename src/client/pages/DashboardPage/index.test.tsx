import { afterEach, describe, expect, it } from "bun:test";
import { cleanup } from "@testing-library/react";
import { useLayoutEffect, useRef, type ReactElement } from "react";
import { ChartType } from "common";
import { Chart, Data, PATH } from "client";
import { buildContext, buildRouter, renderWithContext, resetDom } from "test-render";
import { DashboardPage } from ".";

afterEach(() => {
  cleanup();
  resetDom();
});

/**
 * Records the chart-row order of the first committed paint. React runs
 * layout effects after the commit but before any passive effect, so this
 * observes the sort before DashboardPage's order-converging effect
 * appends unknown ids to the stored list — a settled-DOM assertion
 * cannot pin the wiring, because the effect converges the order either
 * way and the re-render sorts unknown ids last under both comparators.
 * Recorded once: the post-convergence re-render must not overwrite the
 * first paint.
 */
const FirstPaintOrderProbe = ({
  children,
  record,
}: {
  children: ReactElement;
  record: (names: string[]) => void;
}) => {
  const recorded = useRef(false);
  useLayoutEffect(() => {
    if (recorded.current) return;
    recorded.current = true;
    record(
      Array.from(document.querySelectorAll(".BalanceChartRow")).map(
        (el) => el.getAttribute("aria-label") ?? "",
      ),
    );
  }, [record]);
  return children;
};

describe("DashboardPage — chart order", () => {
  it("sorts a chart missing from the stored order last on first paint", () => {
    const data = new Data();
    data.charts.set(
      "chart-a",
      new Chart({ chart_id: "chart-a", name: "Alpha", type: ChartType.BALANCE }),
    );
    data.charts.set(
      "chart-b",
      new Chart({ chart_id: "chart-b", name: "Beta", type: ChartType.BALANCE }),
    );
    data.charts.set(
      "chart-x",
      new Chart({ chart_id: "chart-x", name: "Xray", type: ChartType.BALANCE }),
    );
    // Persisted order knows Beta then Alpha; Xray is new and not yet
    // converged into the list — the exact first-paint case where the old
    // dead-guard comparator hoisted the unknown chart to the front.
    window.localStorage.setItem("chartsOrder", JSON.stringify(["chart-b", "chart-a"]));

    const firstPaint: string[] = [];
    const { router } = buildRouter(PATH.DASHBOARD);
    renderWithContext(
      <FirstPaintOrderProbe record={(names) => firstPaint.push(...names)}>
        <DashboardPage />
      </FirstPaintOrderProbe>,
      buildContext({ data, router }),
    );

    expect(firstPaint).toEqual(["Beta", "Alpha", "Xray"]);
  });
});
