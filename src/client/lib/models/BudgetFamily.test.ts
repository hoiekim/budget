import { test, expect, describe } from "bun:test";
import { MAX_FLOAT } from "common";
// Prime the model graph before importing the concrete subclasses. Data.ts
// fully evaluates BudgetFamily before reaching Budget/Section/Category (which
// `extends BudgetFamily`); importing Budget first instead hits a circular-
// import TDZ ("Cannot access 'BudgetFamily' before initialization").
import "./Data";
import { Budget } from "./Budget";
import { Capacity } from "./Capacity";

// ---------------------------------------------------------------------------
// BudgetFamily.getActiveAmount / getYearlyAmount
//
// Regression coverage for #526: the yearly capacity must be the sum of each
// of the 12 months' active capacities, NOT the single year-end rate × 12.
// Mirrors Calculations.aggregateYear on the spending side so the LabeledBar's
// `left = capacity − spent` compares like-aggregated quantities.
// ---------------------------------------------------------------------------

// A date inside 2026 — getYearlyAmount only reads getFullYear().
const IN_2026 = new Date(2026, 5, 15);

describe("BudgetFamily.getActiveAmount('year')", () => {
  test("single constant capacity → month × 12 (numerically neutral with the old path)", () => {
    const b = new Budget({ capacities: [new Capacity({ month: 1000 })] });
    expect(b.getActiveAmount(IN_2026, "year")).toBe(12000);
  });

  test("mid-year rate cut sums each month, not year-end rate × 12 (#526 repro)", () => {
    // $4000/mo default, lowered to $3000/mo effective 2026-02-01.
    const b = new Budget({
      capacities: [
        new Capacity({ month: 4000 }),
        new Capacity({ month: 3000, active_from: "2026-02-01" as unknown as Date }),
      ],
    });
    // Jan@4000 + Feb–Dec@3000 = 4000 + 11 × 3000 = 37000 — NOT 3000 × 12 = 36000.
    expect(b.getActiveAmount(IN_2026, "year")).toBe(37000);
  });

  test("mid-year rate raise also sums each month", () => {
    // $2000/mo default, raised to $5000/mo effective 2026-07-01.
    const b = new Budget({
      capacities: [
        new Capacity({ month: 2000 }),
        new Capacity({ month: 5000, active_from: "2026-07-01" as unknown as Date }),
      ],
    });
    // Jan–Jun@2000 + Jul–Dec@5000 = 6 × 2000 + 6 × 5000 = 42000 — NOT 5000 × 12 = 60000.
    expect(b.getActiveAmount(IN_2026, "year")).toBe(42000);
  });

  test("a capacity change in a LATER year does not affect the displayed year", () => {
    const b = new Budget({
      capacities: [
        new Capacity({ month: 1000 }),
        new Capacity({ month: 9999, active_from: "2027-01-01" as unknown as Date }),
      ],
    });
    expect(b.getActiveAmount(IN_2026, "year")).toBe(12000);
  });

  test("infinite (MAX_FLOAT) capacity poisons the year to +MAX_FLOAT, no overflow", () => {
    const b = new Budget({ capacities: [new Capacity({ month: MAX_FLOAT })] });
    expect(b.getActiveAmount(IN_2026, "year")).toBe(MAX_FLOAT);
  });

  test("infinite income (-MAX_FLOAT) capacity poisons the year to -MAX_FLOAT", () => {
    const b = new Budget({ capacities: [new Capacity({ month: -MAX_FLOAT })] });
    expect(b.getActiveAmount(IN_2026, "year")).toBe(-MAX_FLOAT);
  });

  test("income (negative finite) capacity stays negative across the year", () => {
    const b = new Budget({ capacities: [new Capacity({ month: -1500 })] });
    expect(b.getActiveAmount(IN_2026, "year")).toBe(-18000);
  });

  test("month interval is unchanged — resolves the period-end active capacity", () => {
    const b = new Budget({
      capacities: [
        new Capacity({ month: 4000 }),
        new Capacity({ month: 3000, active_from: "2026-02-01" as unknown as Date }),
      ],
    });
    // March 2026 → the $3000 capacity is active.
    expect(b.getActiveAmount(new Date(2026, 2, 15), "month")).toBe(3000);
    // January 2026 → still the $4000 default.
    expect(b.getActiveAmount(new Date(2026, 0, 15), "month")).toBe(4000);
  });
});
