import { describe, expect, it } from "bun:test";
import {
  describeGoalInference,
  getLatestActiveFrom,
  getLivingCostAmount,
  inferGoalConfig,
  inferLivingCost,
  inferSavingConfig,
  inferTaxRate,
} from "./charts";
import { AmountInTime, BalanceData, Budget, Capacity } from "client";
import type { BudgetFamily } from "client/lib/models/BudgetFamily";
import { estimateIncomeTax, MAX_FLOAT, TAX_YEAR, ViewDate } from "common";

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
    // A new budget's default capacity is 0: selected, but nothing to add.
    expect(inferLivingCost([budget("new", [monthly(0)])], TODAY)).toBeUndefined();
  });
});

describe("getLivingCostAmount", () => {
  it("counts spending and nothing else", () => {
    expect(getLivingCostAmount(budget("rent", [monthly(2000)]), TODAY)).toBe(2000);
    expect(getLivingCostAmount(budget("salary", [monthly(-8000)]), TODAY)).toBeUndefined();
    expect(getLivingCostAmount(budget("new", [monthly(0)]), TODAY)).toBeUndefined();
    expect(getLivingCostAmount(budget("fun", [monthly(MAX_FLOAT)]), TODAY)).toBeUndefined();
  });
});

describe("inferTaxRate", () => {
  /** The tables' own dollars, so no carrying applies. */
  const TABLE_DATE = new Date(TAX_YEAR, 6, 1);
  const YEAR_MS = 365.25 * 864e5;

  /** What is left after tax of the income the projection grosses `net` up to. */
  const netAfterGrossUp = (net: number, rate: number, state?: string) => {
    const gross = net / (1 - rate);
    return gross - estimateIncomeTax(gross, state).total;
  };

  it("grosses twelve months of living cost up to an income that leaves exactly that after tax", () => {
    for (const [monthly, state] of [
      [5000, "CA"],
      [8000, "CA"],
      [8000, "NY"],
      [12000, "CA"],
      [5000, undefined],
    ] as const) {
      const rate = inferTaxRate({ amount: monthly, amountAsOf: TABLE_DATE }, state, 1.03);
      expect(netAfterGrossUp(monthly * 12, rate, state)).toBeCloseTo(monthly * 12, 1);
    }
  });

  it("is higher than the rate on the living cost itself under progressive brackets", () => {
    const rate = inferTaxRate({ amount: 5000, amountAsOf: TABLE_DATE }, "CA", 1.03);
    expect(rate).toBeGreaterThan(estimateIncomeTax(60000, "CA").effectiveRate);
  });

  it("is zero for no living cost", () => {
    expect(inferTaxRate({ amount: 0, amountAsOf: TABLE_DATE }, "CA", 1.03)).toBe(0);
  });

  it("gives a constant real living cost the same rate in every year, not just the tables' year", () => {
    const yoy = 1.025;
    const base = inferTaxRate({ amount: 5000, amountAsOf: TABLE_DATE }, "CA", yoy);
    for (const years of [-4, 1, 5, 10]) {
      const amountAsOf = new Date(TAX_YEAR + years, 6, 1);
      const amount = 5000 * Math.pow(yoy, (amountAsOf.getTime() - TABLE_DATE.getTime()) / YEAR_MS);
      expect(inferTaxRate({ amount, amountAsOf }, "CA", yoy)).toBeCloseTo(base, 10);
    }
  });

  it("carries an amount into the tables' dollars, forward or back, before taxing it", () => {
    const older = new Date(TAX_YEAR - 4, 6, 1);
    const later = new Date(TAX_YEAR + 4, 6, 1);
    const atTables = inferTaxRate({ amount: 5000, amountAsOf: TABLE_DATE }, undefined, 1.05);
    const fromOlder = inferTaxRate({ amount: 5000, amountAsOf: older }, undefined, 1.05);
    const grown = 60000 * Math.pow(1.05, (TABLE_DATE.getTime() - older.getTime()) / YEAR_MS);
    expect(netAfterGrossUp(grown, fromOlder)).toBeCloseTo(grown, 1);
    expect(fromOlder).toBeGreaterThan(atTables);
    expect(inferTaxRate({ amount: 5000, amountAsOf: later }, undefined, 1.05)).toBeLessThan(atTables);
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
    ["salary", budget("salary", [monthly(-8000)]) as unknown as BudgetFamily],
  ]);
  const inflation = {
    year_over_year_inflation: 1.025,
    from: "1996-09",
    to: "2026-09",
    series_id: "CUUR0000SA0",
  };

  it("infers every field when budgets, CPI, and a state are available", () => {
    const result = inferGoalConfig({
      configuration: { ...configuration, budget_ids: [...configuration.budget_ids, "salary"] },
      getBudget: (id) => budgets.get(id),
      inflation,
      state: "CA",
      today: TODAY,
    });
    expect(result.living_cost.amount).toBe(2600);
    expect(result.living_cost.amountAsOf.getTime()).toBe(new Date(2025, 7, 1).getTime());
    expect(result.year_over_year_inflation).toBe(1.025);
    expect(result.living_cost.taxRate).toBeCloseTo(0.0653504, 6);
    // The state reaches the rate: California's share is on top of federal.
    expect(result.living_cost.taxRate!).toBeGreaterThan(
      inferTaxRate(result.living_cost, undefined, 1.025),
    );
    expect(result.state).toBe("CA");
    // Only budgets that add to the living cost are reported: not the income
    // budget, and not the id of a deleted one.
    expect(result.livingCostBudgetIds).toEqual(["rent", "food"]);
  });

  it("keeps the manual living cost and inflation when there is nothing to infer from", () => {
    const result = inferGoalConfig({
      configuration: { ...configuration, budget_ids: [] },
      getBudget: (id) => budgets.get(id),
      inflation: null,
      state: undefined,
      today: TODAY,
    });
    expect(result.living_cost.amount).toBe(4000);
    expect(result.living_cost.amountAsOf.getTime()).toBe(new Date(2024, 0, 1).getTime());
    expect(result.year_over_year_inflation).toBe(1.038);
    // The tax rate is still estimated (federal only) rather than the stored 30%.
    expect(result.living_cost.taxRate).toBeCloseTo(
      inferTaxRate(manualLivingCost, undefined, 1.038),
      12,
    );
    expect(result.livingCostBudgetIds).toEqual([]);
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

describe("describeGoalInference", () => {
  const inflation = {
    year_over_year_inflation: 1.025,
    from: "2011-09",
    to: "2026-09",
    series_id: "CUUR0000SA0",
  };
  const paragraphs = (text: string) => text.split("\n\n");

  it("names each source: the counted budgets, the residence state, and the CPI range", () => {
    const [livingCost, taxRate, inflationRate] = paragraphs(
      describeGoalInference({ state: "NY", livingCostBudgetIds: ["rent", "food"] }, inflation),
    );
    expect(livingCost).toContain("2 selected spending budgets,");
    expect(taxRate).toContain("federal and New York income tax");
    expect(taxRate).toContain("New York is the state your transactions from the past year show most often");
    expect(inflationRate).toContain("from 2011-09 to 2026-09");
  });

  it("uses the singular for one budget", () => {
    const [livingCost] = paragraphs(describeGoalInference({ livingCostBudgetIds: ["rent"] }, inflation));
    expect(livingCost).toContain("1 selected spending budget,");
  });

  it("says when each value fell back or narrowed", () => {
    const [livingCost, taxRate] = paragraphs(
      describeGoalInference({ state: undefined, livingCostBudgetIds: [] }, inflation),
    );
    expect(livingCost).toContain("your manual amount");
    expect(taxRate).toContain("federal income tax only");
    expect(taxRate).not.toContain(" and ");

    // A code outside the state tables reads as no state, not as "undefined".
    const [, unknownState] = paragraphs(describeGoalInference({ state: "ZZ" }, inflation));
    expect(unknownState).toContain("federal income tax only");
  });

  it("tells a CPI history not collected yet apart from an average that didn't arrive", () => {
    expect(paragraphs(describeGoalInference({}, null))[2]).toContain("hasn't been collected yet");
    expect(paragraphs(describeGoalInference({}, undefined))[2]).toContain("isn't available right now");
  });
});
