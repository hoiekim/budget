import { describe, expect, it } from "bun:test";
import {
  getLatestActiveFrom,
  inferGoalConfig,
  inferLivingCost,
  inferSavingConfig,
  inferTaxRate,
} from "./charts";
import { AmountInTime, BalanceData, Budget, Capacity } from "client";
import type { BudgetFamily } from "client/lib/models/BudgetFamily";
import { estimateIncomeTax, MAX_FLOAT, ViewDate } from "common";

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

// ---------------------------------------------------------------------------
// Auto goal configuration
// ---------------------------------------------------------------------------

const TODAY = new Date(2026, 10, 14); // 2026-11-14

const budget = (id: string, capacities: Capacity[]) =>
  new Budget({ budget_id: id, name: id, capacities });

const monthly = (month: number, active_from?: string) =>
  new Capacity({ month, active_from: active_from as unknown as Date });

/** A synced parent whose amount is its children's sum, without touching globalData. */
const syncedStub = (activeFrom: Date | undefined, children: BudgetFamily[]): BudgetFamily =>
  ({
    getActiveCapacity: () => new Capacity({ is_synced: true, active_from: activeFrom }),
    getChildren: () => children,
  }) as unknown as BudgetFamily;

describe("getLatestActiveFrom", () => {
  it("is the active capacity's start for a non-synced entity", () => {
    const b = budget("b", [monthly(100), monthly(200, "2025-03-01"), monthly(300, "2027-01-01")]);
    expect(getLatestActiveFrom(b, TODAY)?.getTime()).toBe(new Date(2025, 2, 1).getTime());
  });

  it("is undefined when the only capacity is the undated default", () => {
    expect(getLatestActiveFrom(budget("b", [monthly(100)]), TODAY)).toBeUndefined();
  });

  it("reaches into the children of a synced capacity", () => {
    const child = budget("child", [monthly(50), monthly(80, "2026-06-01")]);
    const parent = syncedStub(new Date(2024, 0, 1), [child as unknown as BudgetFamily]);
    expect(getLatestActiveFrom(parent, TODAY)?.getTime()).toBe(new Date(2026, 5, 1).getTime());
  });
});

describe("inferLivingCost", () => {
  it("sums the selected budgets' monthly amounts", () => {
    const result = inferLivingCost(
      [budget("rent", [monthly(2000)]), budget("food", [monthly(600)])],
      TODAY,
    );
    expect(result?.amount).toBe(2600);
  });

  it("is as of the latest start date among the budgets' active periods", () => {
    const result = inferLivingCost(
      [
        budget("rent", [monthly(1800), monthly(2000, "2025-08-01")]),
        budget("food", [monthly(500), monthly(600, "2026-02-01")]),
      ],
      TODAY,
    );
    expect(result?.amount).toBe(2600);
    expect(result?.amountAsOf.getTime()).toBe(new Date(2026, 1, 1).getTime());
  });

  it("ignores a future period that is not active yet", () => {
    const result = inferLivingCost(
      [budget("rent", [monthly(2000, "2025-08-01"), monthly(2500, "2027-01-01")])],
      TODAY,
    );
    expect(result?.amount).toBe(2000);
    expect(result?.amountAsOf.getTime()).toBe(new Date(2025, 7, 1).getTime());
  });

  it("falls back to the start of the current month when no period is dated", () => {
    const result = inferLivingCost([budget("rent", [monthly(2000)])], TODAY);
    expect(result?.amountAsOf.getTime()).toBe(
      new ViewDate("month", TODAY).getStartDate().getTime(),
    );
  });

  it("skips income and unlimited budgets", () => {
    const result = inferLivingCost(
      [
        budget("rent", [monthly(2000)]),
        budget("salary", [monthly(-8000)]),
        budget("fun", [monthly(MAX_FLOAT)]),
      ],
      TODAY,
    );
    expect(result?.amount).toBe(2000);
  });

  it("is undefined when nothing contributes", () => {
    expect(inferLivingCost([], TODAY)).toBeUndefined();
    expect(inferLivingCost([budget("salary", [monthly(-8000)])], TODAY)).toBeUndefined();
  });
});

describe("inferTaxRate", () => {
  const asOfToday = { amount: 5000, amountAsOf: TODAY };

  it("treats twelve months of living cost as the year's income", () => {
    expect(inferTaxRate(asOfToday, undefined, 1.03, TODAY)).toBeCloseTo(
      estimateIncomeTax(60000).effectiveRate,
      12,
    );
  });

  it("is zero for no living cost", () => {
    expect(inferTaxRate({ amount: 0, amountAsOf: TODAY }, "CA", 1.03, TODAY)).toBe(0);
  });

  it("carries an older amount into current dollars before taxing it", () => {
    const fourYearsAgo = new Date(2022, 10, 14);
    const rate = inferTaxRate({ amount: 5000, amountAsOf: fourYearsAgo }, undefined, 1.05, TODAY);
    const grown = 60000 * Math.pow(1.05, (TODAY.getTime() - fourYearsAgo.getTime()) / (365.25 * 864e5));
    expect(rate).toBeCloseTo(estimateIncomeTax(grown).effectiveRate, 12);
    expect(rate).toBeGreaterThan(inferTaxRate(asOfToday, undefined, 1.05, TODAY));
  });
});

describe("inferGoalConfig", () => {
  const manualLivingCost = new AmountInTime({
    amount: 4000,
    amountAsOf: new Date(2024, 0, 1),
    taxRate: 0.3,
  });
  const configuration = {
    budget_ids: ["rent", "food", "deleted-budget"],
    living_cost: manualLivingCost,
    year_over_year_inflation: 1.038,
  };
  const budgets = new Map<string, BudgetFamily>([
    ["rent", budget("rent", [monthly(2000, "2025-08-01")]) as unknown as BudgetFamily],
    ["food", budget("food", [monthly(600)]) as unknown as BudgetFamily],
  ]);
  const inflation = {
    year_over_year_inflation: 1.025,
    from: "1996-09",
    to: "2026-09",
    series_id: "CUUR0000SA0",
  };

  it("infers every field when budgets, CPI, and a state are available", () => {
    const result = inferGoalConfig({
      configuration,
      getBudget: (id) => budgets.get(id),
      inflation,
      state: "TX",
      today: TODAY,
    });
    expect(result.livingCostSource).toBe("budgets");
    expect(result.inflationSource).toBe("cpi");
    expect(result.living_cost.amount).toBe(2600);
    expect(result.living_cost.amountAsOf.getTime()).toBe(new Date(2025, 7, 1).getTime());
    expect(result.year_over_year_inflation).toBe(1.025);
    expect(result.living_cost.taxRate).toBeCloseTo(
      inferTaxRate(result.living_cost, "TX", 1.025, TODAY),
      12,
    );
    expect(result.state).toBe("TX");
  });

  it("keeps the manual living cost and inflation when there is nothing to infer from", () => {
    const result = inferGoalConfig({
      configuration: { ...configuration, budget_ids: [] },
      getBudget: (id) => budgets.get(id),
      inflation: null,
      state: undefined,
      today: TODAY,
    });
    expect(result.livingCostSource).toBe("manual");
    expect(result.inflationSource).toBe("manual");
    expect(result.living_cost.amount).toBe(4000);
    expect(result.living_cost.amountAsOf.getTime()).toBe(new Date(2024, 0, 1).getTime());
    expect(result.year_over_year_inflation).toBe(1.038);
    // The tax rate is still estimated (federal only) rather than the stored 30%.
    expect(result.living_cost.taxRate).toBeCloseTo(
      inferTaxRate(manualLivingCost, undefined, 1.038, TODAY),
      12,
    );
    expect(result.living_cost.taxRate).not.toBe(0.3);
  });

  it("does not mutate the stored manual living cost", () => {
    inferGoalConfig({
      configuration: { ...configuration, budget_ids: [] },
      getBudget: () => undefined,
      inflation: undefined,
      state: "CA",
      today: TODAY,
    });
    expect(manualLivingCost.taxRate).toBe(0.3);
  });
});
