import { getDateString, LocalDate } from "common";
import { Transaction } from "client";

export type RecurringCadence =
  | "weekly"
  | "biweekly"
  | "monthly"
  | "quarterly"
  | "semiannual"
  | "yearly";

export const CADENCE_LABELS: Record<RecurringCadence, string> = {
  weekly: "Weekly",
  biweekly: "Biweekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  semiannual: "Semiannual",
  yearly: "Yearly",
};

export interface RecurringBill {
  /** Display name — the most common raw merchant/name string in the group. */
  merchant: string;
  cadence: RecurringCadence;
  /** Median charge amount (positive — bills are money-out). */
  amount: number;
  isoCurrencyCode: string | null;
  occurrences: number;
  /** First observed charge, YYYY-MM-DD. */
  firstDate: string;
  /** Most recent observed charge, YYYY-MM-DD. */
  lastDate: string;
  /** Projected next charge date, YYYY-MM-DD. */
  nextExpectedDate: string;
  /** transaction_ids of the grouped occurrences, oldest first. */
  transactionIds: string[];
}

interface CadenceSpec {
  cadence: RecurringCadence;
  /** Nominal interval in days. Every observed interval must land within
   *  ±toleranceDays of this for the group to qualify. */
  days: number;
  toleranceDays: number;
}

const CADENCE_SPECS: CadenceSpec[] = [
  { cadence: "weekly", days: 7, toleranceDays: 2 },
  { cadence: "biweekly", days: 14, toleranceDays: 3 },
  { cadence: "monthly", days: 30.44, toleranceDays: 5 },
  { cadence: "quarterly", days: 91.31, toleranceDays: 10 },
  { cadence: "semiannual", days: 182.62, toleranceDays: 15 },
  { cadence: "yearly", days: 365.25, toleranceDays: 30 },
];

/** Minimum settled occurrences before a merchant group is considered. */
const MIN_OCCURRENCES = 3;
/**
 * Every charge must land within ±25% of the group's median amount.
 * Bills like utilities legitimately vary; tighter than this drops real
 * bills, looser admits coincidental same-merchant spending.
 */
const AMOUNT_TOLERANCE_RATIO = 0.25;
/**
 * A group whose most recent charge is older than 2× its cadence is treated
 * as lapsed (cancelled subscription, switched provider, …) and excluded —
 * the page is "what am I paying now", not history.
 */
const LAPSED_CADENCE_MULTIPLE = 2;

/**
 * Domain-suffix tokens that Plaid appends to web-billed merchants
 * ("NETFLIX.COM" vs "Netflix"). Stripped only in trailing position so a
 * merchant genuinely named e.g. "Comcast" (leading token) is untouched.
 */
const DOMAIN_SUFFIX_TOKENS = new Set(["com", "net", "org"]);

/**
 * Normalize a merchant display string into a grouping key. Plaid merchant
 * names carry per-charge noise — domain suffixes ("NETFLIX.COM"),
 * phone-number suffixes ("Netflix 8665795717"), punctuation, case drift —
 * so the key lowercases, drops punctuation, drops long digit runs
 * (reference/phone numbers) while keeping short ones ("7-Eleven" keeps
 * its 7), and drops trailing domain-suffix tokens.
 */
export const normalizeMerchantName = (raw: string): string => {
  const cleaned = raw.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ");
  const tokens = cleaned.split(/\s+/).filter((token) => token && !/^\d{5,}$/.test(token));
  while (tokens.length > 1 && DOMAIN_SUFFIX_TOKENS.has(tokens[tokens.length - 1]!)) {
    tokens.pop();
  }
  return tokens.join(" ");
};

const medianOfSorted = (sorted: number[]): number => {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const daysBetween = (a: LocalDate, b: LocalDate): number =>
  // LocalDates are local-midnight based; rounding absorbs the 23/25-hour
  // days around DST transitions.
  Math.round((b.getTime() - a.getTime()) / 86_400_000);

const addCadence = (date: LocalDate, cadence: RecurringCadence): LocalDate => {
  const next = new LocalDate(date);
  switch (cadence) {
    case "weekly":
      next.setDate(next.getDate() + 7);
      break;
    case "biweekly":
      next.setDate(next.getDate() + 14);
      break;
    case "monthly":
      next.setMonth(next.getMonth() + 1);
      break;
    case "quarterly":
      next.setMonth(next.getMonth() + 3);
      break;
    case "semiannual":
      next.setMonth(next.getMonth() + 6);
      break;
    case "yearly":
      next.setFullYear(next.getFullYear() + 1);
      break;
  }
  return next;
};

interface Occurrence {
  date: LocalDate;
  amount: number;
  id: string;
  display: string;
  isoCurrencyCode: string | null;
}

/**
 * Detect recurring bills from settled outflow transactions — a pure
 * client-side derivation over the synced transaction set. The caller owns
 * candidate selection (pending/zero-amount/hidden-account/confirmed-transfer
 * filtering); this function only groups and qualifies.
 *
 * A merchant group becomes a bill when it has ≥3 occurrences whose
 * consecutive intervals all land within tolerance of one cadence, whose
 * amounts all land within ±25% of the median, and whose most recent charge
 * is within 2× the cadence of `now` (lapsed bills are excluded).
 *
 * `now` is injectable so tests can pin the recency check.
 */
export const detectRecurringBills = (
  transactions: Iterable<Transaction>,
  now: Date = new Date(),
): RecurringBill[] => {
  const groups = new Map<string, Occurrence[]>();
  for (const t of transactions) {
    // Bills are money-out: Plaid-positive amounts. Inflows, zero-amount
    // corrections, and pending (unsettled) rows can't anchor a bill.
    if (t.pending || !(t.amount > 0)) continue;
    const key = normalizeMerchantName(t.merchant_name || t.name || "");
    if (!key) continue;
    const date = new LocalDate(t.authorized_date || t.date);
    if (Number.isNaN(date.getTime())) continue;
    const occurrence: Occurrence = {
      date,
      amount: t.amount,
      id: t.transaction_id,
      display: t.merchant_name || t.name,
      isoCurrencyCode: t.iso_currency_code || t.unofficial_currency_code,
    };
    const list = groups.get(key);
    if (list) list.push(occurrence);
    else groups.set(key, [occurrence]);
  }

  const today = new LocalDate(now);
  const bills: RecurringBill[] = [];

  for (const occurrences of groups.values()) {
    if (occurrences.length < MIN_OCCURRENCES) continue;
    occurrences.sort((a, b) => a.date.getTime() - b.date.getTime());

    const intervals: number[] = [];
    for (let i = 1; i < occurrences.length; i++) {
      intervals.push(daysBetween(occurrences[i - 1]!.date, occurrences[i]!.date));
    }
    const medianInterval = medianOfSorted([...intervals].sort((a, b) => a - b));
    const spec = CADENCE_SPECS.find(
      (s) => Math.abs(medianInterval - s.days) <= s.toleranceDays,
    );
    if (!spec) continue;
    if (!intervals.every((d) => Math.abs(d - spec.days) <= spec.toleranceDays)) continue;

    const medianAmount = medianOfSorted(
      occurrences.map((o) => o.amount).sort((a, b) => a - b),
    );
    const amountOk = occurrences.every(
      (o) => Math.abs(o.amount - medianAmount) <= medianAmount * AMOUNT_TOLERANCE_RATIO,
    );
    if (!amountOk) continue;

    const first = occurrences[0]!;
    const last = occurrences[occurrences.length - 1]!;
    if (daysBetween(last.date, today) > spec.days * LAPSED_CADENCE_MULTIPLE) continue;

    // Display name: the most common raw merchant/name string in the group,
    // so "NETFLIX.COM" beats a one-off "Netflix 8665795717" variant.
    const displayCounts = new Map<string, number>();
    let display = first.display;
    let displayBest = 0;
    for (const o of occurrences) {
      const count = (displayCounts.get(o.display) || 0) + 1;
      displayCounts.set(o.display, count);
      if (count > displayBest) {
        displayBest = count;
        display = o.display;
      }
    }
    const currencyCounts = new Map<string | null, number>();
    let isoCurrencyCode: string | null = null;
    let currencyBest = 0;
    for (const o of occurrences) {
      const count = (currencyCounts.get(o.isoCurrencyCode) || 0) + 1;
      currencyCounts.set(o.isoCurrencyCode, count);
      if (count > currencyBest) {
        currencyBest = count;
        isoCurrencyCode = o.isoCurrencyCode;
      }
    }

    bills.push({
      merchant: display,
      cadence: spec.cadence,
      amount: medianAmount,
      isoCurrencyCode,
      occurrences: occurrences.length,
      firstDate: getDateString(first.date),
      lastDate: getDateString(last.date),
      nextExpectedDate: getDateString(addCadence(last.date, spec.cadence)),
      transactionIds: occurrences.map((o) => o.id),
    });
  }

  bills.sort((a, b) => (a.nextExpectedDate < b.nextExpectedDate ? -1 : 1));
  return bills;
};
