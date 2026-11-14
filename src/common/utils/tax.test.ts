import { describe, expect, it } from "bun:test";
import {
  applyPhaseOut,
  computeBracketTax,
  estimateFederalIncomeTax,
  estimateIncomeTax,
  estimateStateIncomeTax,
  inferResidenceState,
  normalizeStateCode,
  US_STATE_NAMES,
  StateIncomeTaxTable,
  TaxBracket,
} from "./tax";
import { FEDERAL_INCOME_TAX, STATE_INCOME_TAX, TAX_YEAR } from "./tax-tables";

describe("computeBracketTax", () => {
  const brackets: TaxBracket[] = [
    [0, 0.1],
    [10000, 0.2],
    [50000, 0.3],
  ];

  it("taxes each slice of income at its own rate", () => {
    expect(computeBracketTax(5000, brackets)).toBeCloseTo(500, 9);
    expect(computeBracketTax(10000, brackets)).toBeCloseTo(1000, 9);
    expect(computeBracketTax(30000, brackets)).toBeCloseTo(1000 + 4000, 9);
    expect(computeBracketTax(80000, brackets)).toBeCloseTo(1000 + 8000 + 9000, 9);
  });

  it("is zero for no, negative, or non-numeric income, and for no brackets", () => {
    expect(computeBracketTax(0, brackets)).toBe(0);
    expect(computeBracketTax(-100, brackets)).toBe(0);
    expect(computeBracketTax(NaN, brackets)).toBe(0);
    expect(computeBracketTax(50000, [])).toBe(0);
  });

  it("handles a flat tax", () => {
    expect(computeBracketTax(40000, [[0, 0.05]])).toBeCloseTo(2000, 9);
  });
});

describe("estimateStateIncomeTax", () => {
  const tables: Record<string, StateIncomeTaxTable> = {
    XX: {
      brackets: [
        [0, 0.02],
        [10000, 0.05],
      ],
      standardDeduction: 2000,
      personalExemption: 1000,
      personalCredit: 0,
    },
    YY: { brackets: [[0, 0.04]], standardDeduction: 0, personalExemption: 0, personalCredit: 150 },
    ZZ: { brackets: [], standardDeduction: 0, personalExemption: 0, personalCredit: 0 },
  };

  it("subtracts the deduction and exemption before applying the brackets", () => {
    // taxable = 30000 - 3000 = 27000 → 10000 × 2% + 17000 × 5%
    expect(estimateStateIncomeTax(30000, "XX", tables)).toBeCloseTo(200 + 850, 9);
  });

  it("applies a personal credit against tax, never below zero", () => {
    expect(estimateStateIncomeTax(10000, "YY", tables)).toBeCloseTo(400 - 150, 9);
    expect(estimateStateIncomeTax(2000, "YY", tables)).toBe(0);
  });

  it("shrinks a phased-out allowance linearly across its income range", () => {
    const phased: Record<string, StateIncomeTaxTable> = {
      PX: {
        brackets: [[0, 0.1]],
        standardDeduction: 0,
        personalExemption: 10000,
        personalCredit: 0,
        phaseOut: { allowance: "personalExemption", from: 20000, to: 30000 },
      },
    };
    expect(estimateStateIncomeTax(20000, "PX", phased)).toBeCloseTo(1000, 9); // full exemption
    expect(estimateStateIncomeTax(25000, "PX", phased)).toBeCloseTo(2000, 9); // half: 25000 - 5000
    expect(estimateStateIncomeTax(40000, "PX", phased)).toBeCloseTo(4000, 9); // none
  });

  it("is zero for a state with no income tax, an unknown state, or no state", () => {
    expect(estimateStateIncomeTax(100000, "ZZ", tables)).toBe(0);
    expect(estimateStateIncomeTax(100000, "QQ", tables)).toBe(0);
    expect(estimateStateIncomeTax(100000, undefined, tables)).toBe(0);
  });
});

describe("estimateIncomeTax", () => {
  it("adds federal and state tax and reports the effective rate", () => {
    const income = 90000;
    const result = estimateIncomeTax(income, "CA");
    expect(result.federal).toBeCloseTo(estimateFederalIncomeTax(income), 9);
    expect(result.state).toBeCloseTo(estimateStateIncomeTax(income, "CA"), 9);
    expect(result.total).toBeCloseTo(result.federal + result.state, 9);
    expect(result.effectiveRate).toBeCloseTo(result.total / income, 12);
  });

  it("is all zeros for no income", () => {
    expect(estimateIncomeTax(0, "CA")).toEqual({ federal: 0, state: 0, total: 0, effectiveRate: 0 });
    expect(estimateIncomeTax(-5, "CA").effectiveRate).toBe(0);
    expect(estimateIncomeTax(NaN).effectiveRate).toBe(0);
  });

  it("owes no federal tax below the standard deduction", () => {
    expect(estimateFederalIncomeTax(FEDERAL_INCOME_TAX.standardDeduction - 1)).toBe(0);
  });

  it("is progressive: a higher income never has a lower effective rate", () => {
    let previous = 0;
    for (let income = 10000; income <= 2_000_000; income += 10000) {
      const rate = estimateIncomeTax(income, "NY").effectiveRate;
      expect(rate).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = rate;
    }
  });
});

describe("tax tables", () => {
  it("cover every state and DC, and nothing else", () => {
    expect(Object.keys(STATE_INCOME_TAX).sort()).toEqual(Object.keys(US_STATE_NAMES).sort());
  });

  it("are well-formed: ascending thresholds from zero, rates in [0, 1)", () => {
    const check = (brackets: TaxBracket[]) => {
      if (!brackets.length) return;
      expect(brackets[0][0]).toBe(0);
      for (let i = 0; i < brackets.length; i++) {
        const [threshold, rate] = brackets[i];
        expect(rate).toBeGreaterThanOrEqual(0);
        expect(rate).toBeLessThan(1);
        if (i > 0) expect(threshold).toBeGreaterThan(brackets[i - 1][0]);
      }
    };
    check(FEDERAL_INCOME_TAX.brackets);
    for (const table of Object.values(STATE_INCOME_TAX)) {
      check(table.brackets);
      expect(table.standardDeduction).toBeGreaterThanOrEqual(0);
      expect(table.personalExemption).toBeGreaterThanOrEqual(0);
      expect(table.personalCredit).toBeGreaterThanOrEqual(0);
    }
  });

  it("tax no wages in the states without a wage income tax", () => {
    for (const code of ["AK", "FL", "NV", "NH", "SD", "TN", "TX", "WA", "WY"]) {
      expect(estimateStateIncomeTax(150000, code)).toBe(0);
    }
  });

  it(`use ${TAX_YEAR} federal figures for a single filer`, () => {
    expect(TAX_YEAR).toBe(2026);
    expect(FEDERAL_INCOME_TAX.standardDeduction).toBe(16100);
    expect(FEDERAL_INCOME_TAX.brackets).toEqual([
      [0, 0.1],
      [12400, 0.12],
      [50400, 0.22],
      [105700, 0.24],
      [201775, 0.32],
      [256225, 0.35],
      [640600, 0.37],
    ]);
  });
});

describe("applyPhaseOut", () => {
  it("keeps the full amount up to `from`, none from `to`, and interpolates between", () => {
    expect(applyPhaseOut(900, 10, 100, 400)).toBe(900);
    expect(applyPhaseOut(900, 100, 100, 400)).toBe(900);
    expect(applyPhaseOut(900, 200, 100, 400)).toBeCloseTo(600, 9);
    expect(applyPhaseOut(900, 400, 100, 400)).toBe(0);
    expect(applyPhaseOut(900, 1000, 100, 400)).toBe(0);
  });

  it("treats an empty range as fully phased out past it", () => {
    expect(applyPhaseOut(900, 101, 100, 100)).toBe(0);
  });
});

describe("tax table spot checks (computed by hand)", () => {
  it("federal: $60,000 → 10% of $12,400 + 12% of $31,500 = $5,020", () => {
    expect(estimateFederalIncomeTax(60000)).toBeCloseTo(5020, 6);
  });

  it("Pennsylvania: flat 3.07% with no deduction → $1,842 on $60,000", () => {
    expect(estimateStateIncomeTax(60000, "PA")).toBeCloseTo(1842, 6);
  });

  it("Connecticut: the $15,000 exemption is two-thirds gone at $40,000", () => {
    // exemption 15000 × (1 - 10000/15000) = 5000 → taxable 35000
    // 2% × 10000 + 4.5% × 25000 = 200 + 1125
    expect(estimateStateIncomeTax(40000, "CT")).toBeCloseTo(1325, 6);
  });

  it("Utah: the taxpayer credit is gone well before $100,000", () => {
    expect(estimateStateIncomeTax(100000, "UT")).toBeCloseTo(4450, 6);
  });

  it("a high-tax state costs more than a no-tax one at the same income", () => {
    expect(estimateIncomeTax(80000, "CA").total).toBeGreaterThan(estimateIncomeTax(80000, "TX").total);
    expect(estimateIncomeTax(80000, "TX").state).toBe(0);
  });
});

describe("normalizeStateCode", () => {
  it("accepts two-letter codes in any case and full names", () => {
    expect(normalizeStateCode("CA")).toBe("CA");
    expect(normalizeStateCode(" ny ")).toBe("NY");
    expect(normalizeStateCode("Texas")).toBe("TX");
    expect(normalizeStateCode("district of columbia")).toBe("DC");
    expect(normalizeStateCode("Washington DC")).toBe("DC");
  });

  it("rejects anything that is not a state or DC", () => {
    expect(normalizeStateCode("ON")).toBeUndefined(); // Ontario
    expect(normalizeStateCode("PR")).toBeUndefined(); // territory
    expect(normalizeStateCode("Somewhere")).toBeUndefined();
    expect(normalizeStateCode("")).toBeUndefined();
    expect(normalizeStateCode(null)).toBeUndefined();
    expect(normalizeStateCode(undefined)).toBeUndefined();
  });
});

describe("inferResidenceState", () => {
  const NOW = new Date(2026, 10, 14, 12);
  const tx = (date: string, region: string | null, country: string | null = "US") => ({
    date,
    location: {
      address: null,
      city: null,
      region,
      postal_code: null,
      country,
      lat: null,
      lon: null,
      store_number: null,
    },
  });

  it("picks the state that appears most often in the past year", () => {
    const state = inferResidenceState(
      [
        tx("2026-10-01", "WA"),
        tx("2026-10-02", "WA"),
        tx("2026-10-03", "OR"),
        tx("2026-11-01", "WA"),
        tx("2026-11-10", "CA"),
      ],
      NOW,
    );
    expect(state).toBe("WA");
  });

  it("ignores transactions older than a year or in the future", () => {
    const state = inferResidenceState(
      [
        tx("2025-11-13", "NY"),
        tx("2025-11-12", "NY"),
        tx("2027-01-01", "NY"),
        tx("2026-06-01", "NJ"),
      ],
      NOW,
    );
    expect(state).toBe("NJ");
  });

  it("counts the boundary day a year ago", () => {
    expect(inferResidenceState([tx("2025-11-14", "NY")], NOW)).toBe("NY");
  });

  it("breaks a tie in favor of the most recently seen state", () => {
    const state = inferResidenceState(
      [tx("2026-01-01", "MA"), tx("2026-02-01", "MA"), tx("2026-03-01", "NH"), tx("2026-09-01", "NH")],
      NOW,
    );
    expect(state).toBe("NH");
  });

  it("skips a foreign region even when its code is also a state's", () => {
    // Western Australia is "WA", the same code as Washington.
    const state = inferResidenceState(
      [
        tx("2026-10-01", "WA", "AU"),
        tx("2026-10-02", "WA", "Australia"),
        tx("2026-10-03", "WA", "AU"),
        tx("2026-10-04", "OR", "US"),
      ],
      NOW,
    );
    expect(state).toBe("OR");
  });

  it("skips unlocated transactions and normalizes spelled-out names", () => {
    const state = inferResidenceState(
      [tx("2026-10-04", null), tx("2026-10-05", null), tx("2026-10-07", "Colorado", null)],
      NOW,
    );
    expect(state).toBe("CO");
  });

  it("accepts date-time strings", () => {
    expect(inferResidenceState([tx("2026-10-01T09:30:00", "IL")], NOW)).toBe("IL");
  });

  it("is undefined with no usable transaction", () => {
    expect(inferResidenceState([], NOW)).toBeUndefined();
    expect(inferResidenceState([tx("2026-10-01", null)], NOW)).toBeUndefined();
  });
});
