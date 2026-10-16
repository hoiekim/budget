import { describe, expect, test } from "bun:test";
import {
  normalizeMerchantName,
  detectRecurringGroups,
  RecurringCandidate,
} from "./detect-recurrings";

const NOW = new Date("2026-10-15T12:00:00Z");

const txn = (
  partial: Partial<RecurringCandidate> & { transaction_id: string },
): RecurringCandidate => ({
  amount: 15.99,
  date: "2026-09-15",
  merchant_name: "Netflix",
  name: "Netflix",
  ...partial,
});

/** Monthly charges on the 15th, `count` of them ending Sep 2026. */
const monthlyTxns = (
  merchant: string,
  count: number,
  amount = 15.99,
): RecurringCandidate[] =>
  Array.from({ length: count }, (_, i) => {
    const d = new Date(2026, 8 - i, 15); // Sep 2026 backwards
    return txn({
      transaction_id: `${merchant}-${i}`,
      merchant_name: merchant,
      name: merchant,
      amount,
      date: d.toISOString().slice(0, 10),
    });
  });

describe("normalizeMerchantName", () => {
  test("lowercases and strips punctuation", () => {
    expect(normalizeMerchantName("NETFLIX.COM")).toBe("netflix");
  });

  test("drops long digit runs but keeps short ones", () => {
    expect(normalizeMerchantName("Netflix 8665795717")).toBe("netflix");
    expect(normalizeMerchantName("7-Eleven")).toBe("7 eleven");
  });

  test("strips trailing domain suffixes only", () => {
    expect(normalizeMerchantName("Comcast")).toBe("comcast");
    expect(normalizeMerchantName("Hulu LLC")).toBe("hulu llc");
  });
});

describe("detectRecurringGroups", () => {
  test("detects a monthly bill", () => {
    const groups = detectRecurringGroups(monthlyTxns("Netflix", 4), NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.merchant_key).toBe("netflix");
    expect(groups[0]!.merchant_name).toBe("Netflix");
    expect(groups[0]!.cadence).toBe("monthly");
    expect(groups[0]!.is_income).toBe(false);
    expect(groups[0]!.transaction_ids).toHaveLength(4);
  });

  test("requires at least 3 occurrences", () => {
    const groups = detectRecurringGroups(monthlyTxns("Netflix", 2), NOW);
    expect(groups).toHaveLength(0);
  });

  test("detects recurring income separately from expenses", () => {
    const income = monthlyTxns("Employer", 4, -3000).map((t) => ({
      ...t,
      merchant_name: "Employer Inc",
      name: "Employer Inc",
    }));
    const expense = monthlyTxns("Netflix", 4);
    const groups = detectRecurringGroups([...income, ...expense], NOW);
    expect(groups).toHaveLength(2);
    const inc = groups.find((g) => g.is_income)!;
    const exp = groups.find((g) => !g.is_income)!;
    expect(inc.merchant_key).toBe("employer inc");
    expect(exp.merchant_key).toBe("netflix");
  });

  test("groups noisy merchant name variants", () => {
    const txns = monthlyTxns("Netflix", 4).map((t, i) => ({
      ...t,
      merchant_name: i === 3 ? "Netflix 8665795717" : "NETFLIX.COM",
    }));
    const groups = detectRecurringGroups(txns, NOW);
    expect(groups).toHaveLength(1);
    // Display name is the most common raw variant.
    expect(groups[0]!.merchant_name).toBe("NETFLIX.COM");
  });

  test("rejects irregular intervals", () => {
    const txns = [
      txn({ transaction_id: "a", date: "2026-09-15" }),
      txn({ transaction_id: "b", date: "2026-09-20" }),
      txn({ transaction_id: "c", date: "2026-10-15" }),
    ];
    expect(detectRecurringGroups(txns, NOW)).toHaveLength(0);
  });

  test("rejects amounts outside ±25% of the median", () => {
    const txns = monthlyTxns("Utility", 4).map((t, i) => ({
      ...t,
      amount: i === 3 ? 100 : 15.99,
    }));
    expect(detectRecurringGroups(txns, NOW)).toHaveLength(0);
  });

  test("tolerates amounts within ±25% of the median", () => {
    const txns = monthlyTxns("Utility", 4).map((t, i) => ({
      ...t,
      amount: [50, 55, 48, 60][i]!,
    }));
    const groups = detectRecurringGroups(txns, NOW);
    expect(groups).toHaveLength(1);
  });

  test("excludes lapsed groups", () => {
    const txns = [0, 1, 2, 3].map((i) => {
      const d = new Date(2026, 3 - i, 15); // Apr 2026 backwards — lapsed by Oct
      return txn({
        transaction_id: `old-${i}`,
        date: d.toISOString().slice(0, 10),
      });
    });
    expect(detectRecurringGroups(txns, NOW)).toHaveLength(0);
  });

  test("detects weekly cadence", () => {
    const txns = [0, 1, 2, 3].map((i) => {
      const d = new Date(2026, 9, 15 - i * 7);
      return txn({
        transaction_id: `w-${i}`,
        merchant_name: "Gym",
        name: "Gym",
        date: d.toISOString().slice(0, 10),
      });
    });
    const groups = detectRecurringGroups(txns, NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.cadence).toBe("weekly");
  });

  test("skips zero-amount and dateless candidates", () => {
    const txns = [
      ...monthlyTxns("Netflix", 3),
      txn({ transaction_id: "z", amount: 0 }),
      txn({ transaction_id: "d", date: "not-a-date" }),
    ];
    const groups = detectRecurringGroups(txns, NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.transaction_ids).not.toContain("z");
    expect(groups[0]!.transaction_ids).not.toContain("d");
  });

  test("orders transaction_ids oldest first", () => {
    const groups = detectRecurringGroups(monthlyTxns("Netflix", 3), NOW);
    const ids = groups[0]!.transaction_ids;
    expect(ids[0]).toBe("Netflix-2");
    expect(ids[2]).toBe("Netflix-0");
  });
});
