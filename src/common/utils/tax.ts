import { getDateString } from "./date";
import { FEDERAL_INCOME_TAX, STATE_INCOME_TAX, TAX_YEAR } from "./tax-tables";

/**
 * Income tax estimate for the projection chart's auto goal configuration.
 *
 * The chart grosses living cost up by `1 / (1 - taxRate)` to get the income
 * savings must produce. In auto mode that rate is estimated by treating the
 * annual living cost as taxable income for a single filer taking the standard
 * deduction, federal plus the residence state's income tax.
 *
 * Deliberately left out: payroll taxes (withdrawals from savings are not
 * wages), local/city income taxes, credits beyond a state's flat personal
 * credit, and allowance phase-outs except the three that bite at ordinary
 * incomes (see `StateIncomeTaxTable.phaseOut`). The point is a defensible
 * effective rate, not a return.
 */

/** `[lowerThreshold, marginalRate]`, ascending by threshold. */
export type TaxBracket = [number, number];

export interface StateIncomeTaxTable {
  brackets: TaxBracket[];
  standardDeduction: number;
  personalExemption: number;
  /** A flat per-filer credit against tax, for states that use one instead of an exemption. */
  personalCredit: number;
  /**
   * One allowance that shrinks linearly from its full value at income `from`
   * to zero at `to`. Only modeled where the phase-out bites at ordinary
   * incomes (CT, UT, WI); elsewhere allowances apply in full.
   */
  phaseOut?: {
    allowance: "standardDeduction" | "personalExemption" | "personalCredit";
    from: number;
    to: number;
  };
  /** Set when the figures are from a year other than `TAX_YEAR`. */
  taxYear?: number;
}

export interface FederalIncomeTaxTable {
  brackets: TaxBracket[];
  standardDeduction: number;
}

export { TAX_YEAR };

export const US_STATE_NAMES: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
};

const STATE_CODE_BY_NAME = new Map(
  Object.entries(US_STATE_NAMES).map(([code, name]) => [name.toLowerCase(), code]),
);
STATE_CODE_BY_NAME.set("washington dc", "DC");
STATE_CODE_BY_NAME.set("washington d.c.", "DC");
STATE_CODE_BY_NAME.set("d.c.", "DC");

/**
 * Map a transaction's `location.region` to a USPS state code. Plaid sends the
 * two-letter code (`"CA"`); other sources sometimes spell the name out.
 * Anything that is not one of the 50 states or DC — a Canadian province, a
 * territory, free text — is `undefined`.
 */
export const normalizeStateCode = (region: string | null | undefined): string | undefined => {
  if (!region) return undefined;
  const trimmed = region.trim();
  const upper = trimmed.toUpperCase();
  if (upper.length === 2 && upper in US_STATE_NAMES) return upper;
  return STATE_CODE_BY_NAME.get(trimmed.toLowerCase());
};

const US_COUNTRY = new Set(["US", "USA", "UNITED STATES", "UNITED STATES OF AMERICA"]);

export interface LocatedTransaction {
  date: string;
  location?: { region?: string | null; country?: string | null } | null;
}

export const RESIDENCE_LOOKBACK_DAYS = 365;

/**
 * The state the user most likely lives in: the one that appears most often in
 * the locations of their transactions over the past year. Ties go to the state
 * seen most recently. `undefined` when no transaction in the window carries a
 * U.S. state.
 *
 * Counting transactions rather than dollars keeps a single large purchase on
 * a trip from outweighing a year of everyday spending at home.
 */
export const inferResidenceState = (
  transactions: Iterable<LocatedTransaction>,
  now: Date = new Date(),
  lookbackDays: number = RESIDENCE_LOOKBACK_DAYS,
): string | undefined => {
  const end = getDateString(now);
  const start = getDateString(new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000));

  const tally = new Map<string, { count: number; latest: string }>();
  for (const t of transactions) {
    const day = typeof t.date === "string" ? t.date.slice(0, 10) : "";
    if (!day || day < start || day > end) continue;
    const country = t.location?.country?.trim().toUpperCase();
    if (country && !US_COUNTRY.has(country)) continue;
    const code = normalizeStateCode(t.location?.region);
    if (!code) continue;
    const entry = tally.get(code);
    if (entry) {
      entry.count++;
      if (day > entry.latest) entry.latest = day;
    } else {
      tally.set(code, { count: 1, latest: day });
    }
  }

  let best: string | undefined;
  let bestEntry: { count: number; latest: string } | undefined;
  for (const [code, entry] of tally) {
    const wins =
      !bestEntry ||
      entry.count > bestEntry.count ||
      (entry.count === bestEntry.count && entry.latest > bestEntry.latest);
    if (wins) {
      best = code;
      bestEntry = entry;
    }
  }
  return best;
};

/** Tax on `taxableIncome` under progressive `brackets`. */
export const computeBracketTax = (taxableIncome: number, brackets: TaxBracket[]): number => {
  if (!(taxableIncome > 0)) return 0;
  let tax = 0;
  for (let i = 0; i < brackets.length; i++) {
    const [floor, rate] = brackets[i];
    if (taxableIncome <= floor) break;
    const ceiling = i + 1 < brackets.length ? brackets[i + 1][0] : Infinity;
    tax += (Math.min(taxableIncome, ceiling) - floor) * rate;
  }
  return tax;
};

export const estimateFederalIncomeTax = (
  annualIncome: number,
  table: FederalIncomeTaxTable = FEDERAL_INCOME_TAX,
): number => computeBracketTax(annualIncome - table.standardDeduction, table.brackets);

export const estimateStateIncomeTax = (
  annualIncome: number,
  stateCode: string | undefined,
  tables: Record<string, StateIncomeTaxTable> = STATE_INCOME_TAX,
): number => {
  const table = stateCode ? tables[stateCode] : undefined;
  if (!table) return 0;
  const allowance = (key: "standardDeduction" | "personalExemption" | "personalCredit") =>
    table.phaseOut?.allowance === key
      ? applyPhaseOut(table[key], annualIncome, table.phaseOut.from, table.phaseOut.to)
      : table[key];
  const taxable = annualIncome - allowance("standardDeduction") - allowance("personalExemption");
  return Math.max(0, computeBracketTax(taxable, table.brackets) - allowance("personalCredit"));
};

/** `amount` reduced linearly from full at `from` to zero at `to`. */
export const applyPhaseOut = (amount: number, income: number, from: number, to: number): number => {
  if (income <= from) return amount;
  if (income >= to || to <= from) return 0;
  return amount * (1 - (income - from) / (to - from));
};

export interface IncomeTaxEstimate {
  federal: number;
  state: number;
  total: number;
  /** `total / annualIncome`, 0 for no income. */
  effectiveRate: number;
}

/** Federal plus state income tax for a single filer earning `annualIncome`. */
export const estimateIncomeTax = (
  annualIncome: number,
  stateCode?: string,
): IncomeTaxEstimate => {
  const income = Number.isFinite(annualIncome) && annualIncome > 0 ? annualIncome : 0;
  const federal = estimateFederalIncomeTax(income);
  const state = estimateStateIncomeTax(income, stateCode);
  const total = federal + state;
  return { federal, state, total, effectiveRate: income > 0 ? total / income : 0 };
};
