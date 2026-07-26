import { describe, expect, it } from "bun:test";
import { inferSavingConfig } from "./charts";
import { BalanceData } from "client";
import { ViewDate } from "common";

const makeBalanceData = (arrays: Record<string, number[]>): BalanceData =>
  ({
    get: (accountId: string) => ({
      toArray: () => arrays[accountId] ?? [],
    }),
  }) as unknown as BalanceData;

const viewDate = new ViewDate("month");

describe("inferSavingConfig", () => {
  it("returns finite zero contribution when no balance history exists", () => {
    const result = inferSavingConfig(makeBalanceData({ acc: [] }), ["acc"], viewDate);
    expect(result.contribution).toBe(0);
    expect(isFinite(result.contribution)).toBe(true);
  });

  it("returns finite zero contribution with a single snapshot (regression: no division by zero)", () => {
    const result = inferSavingConfig(makeBalanceData({ acc: [1000] }), ["acc"], viewDate);
    expect(isFinite(result.contribution)).toBe(true);
    expect(result.contribution).toBe(0);
  });

  it("sets initial_saving to the oldest balance value (regression: off-by-one)", () => {
    // array[0]=current(1200), array[1]=oldest(800)
    // Bug: balanceArray[maxLength=2] = undefined → startValue was 0
    // Fix: balanceArray[maxLength-1=1] = 800
    const result = inferSavingConfig(makeBalanceData({ acc: [1200, 800] }), ["acc"], viewDate);
    expect(result.initial_saving.amount).toBe(800);
  });

  it("computes a finite, non-NaN contribution for multi-month history", () => {
    const result = inferSavingConfig(makeBalanceData({ acc: [1200, 1100, 1000] }), ["acc"], viewDate);
    expect(isFinite(result.contribution)).toBe(true);
    expect(isNaN(result.contribution)).toBe(false);
  });

  it("sums oldest balances across multiple accounts", () => {
    const result = inferSavingConfig(
      makeBalanceData({ acc1: [1200, 800], acc2: [500, 200] }),
      ["acc1", "acc2"],
      viewDate,
    );
    expect(result.initial_saving.amount).toBe(1000); // 800 + 200
  });
});
