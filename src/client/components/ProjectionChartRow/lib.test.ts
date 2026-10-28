// Run with: bun test --preload ./scripts/test-preload.ts lib.test.ts
import { describe, expect, test } from "bun:test";
import { AmountInTime } from "client";
import { calculateProjection } from "./lib";

const baseConfig = {
  lineColor: "#aaa",
  pointColor: "#aaa",
  startDate: new Date("2026-01-01"),
  initialSaving: new AmountInTime({ amount: 10000, amountAsOf: new Date("2026-01-01") }),
  livingCost: new AmountInTime({ amount: 3000, amountAsOf: new Date("2026-01-01") }),
  contribution: 500,
  anualPercentageYield: 1.09,
  yearOverYearInflation: 1.038,
};

describe("calculateProjection — startOffset guard", () => {
  test("a negative startOffset (empty history sequence) cannot throw a RangeError", () => {
    // ProjectionChartRow reaches here with `startOffset = sequence.length - 1`
    // when no referenced account survives: an empty history sequence gives
    // -1, and `new Array(-1)` throws mid-render, taking the whole app down
    // behind the app-root ErrorBoundary. The offset is clamped so the throw
    // is structurally impossible — the chart degrades instead.
    const result = calculateProjection({ ...baseConfig, startOffset: -1 });

    const sequence = result.graphData.lines[0].sequence;
    expect(sequence.length).toBeGreaterThan(0);
    expect(sequence[0]).toBe(10000);
  });

  test("a zero startOffset still seeds the line with the saved amount", () => {
    const result = calculateProjection({ ...baseConfig, startOffset: 0 });

    expect(result.graphData.lines[0].sequence[0]).toBe(10000);
  });

  test("a positive startOffset pads the line before the saved amount", () => {
    const result = calculateProjection({ ...baseConfig, startOffset: 3 });

    const sequence = result.graphData.lines[0].sequence;
    expect(sequence.slice(0, 3)).toEqual([undefined, undefined, undefined]);
    expect(sequence[3]).toBe(10000);
  });
});
