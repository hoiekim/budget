import { describe, expect, test } from "bun:test";
import {
  normalizeMerchantName,
  detectRecurringGroups,
  selectConfirmedAttachments,
  ConfirmedRecurringSnapshot,
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

describe("selectConfirmedAttachments", () => {
  /** A confirmed monthly Netflix bill whose members are `members`. */
  const netflix = (
    members: RecurringCandidate[],
    overrides: Partial<ConfirmedRecurringSnapshot> = {},
  ): ConfirmedRecurringSnapshot => ({
    merchant_key: "netflix",
    is_income: false,
    cadence: "monthly",
    members,
    ...overrides,
  });

  const charge = (id: string, date: string, amount = 15.99, merchant = "Netflix") =>
    txn({ transaction_id: id, date, amount, merchant_name: merchant, name: merchant });

  const history = [
    charge("jul", "2026-07-15"),
    charge("aug", "2026-08-15"),
    charge("sep", "2026-09-15"),
  ];

  const claimedBy = (...recurrings: ConfirmedRecurringSnapshot[]) =>
    new Set(recurrings.flatMap((r) => r.members.map((m) => m.transaction_id)));

  /** Feed charges in one per run, as the hourly job sees them settle. */
  const runIncrementally = (
    recurring: ConfirmedRecurringSnapshot,
    charges: RecurringCandidate[],
  ): string[] => {
    const members = [...recurring.members];
    const pool: RecurringCandidate[] = [];
    for (const c of charges) {
      pool.push(c);
      const current = { ...recurring, members };
      const picked = selectConfirmedAttachments(current, pool, claimedBy(current));
      members.push(...pool.filter((p) => picked.includes(p.transaction_id)));
    }
    return members
      .map((m) => m.transaction_id)
      .filter((id) => !recurring.members.some((m) => m.transaction_id === id));
  };

  test("attaches the next on-schedule charge", () => {
    const recurring = netflix(history);
    const candidates = [...history, charge("oct", "2026-10-15")];
    expect(
      selectConfirmedAttachments(recurring, candidates, claimedBy(recurring)),
    ).toEqual(["oct"]);
  });

  test("attaches a late charge, and the on-time one after it", () => {
    const recurring = netflix(history);
    const candidates = [
      charge("oct-late", "2026-10-27"),
      charge("nov", "2026-11-15"),
    ];
    expect(
      selectConfirmedAttachments(recurring, candidates, claimedBy(recurring)),
    ).toEqual(["oct-late", "nov"]);
  });

  test("attaches the charge after a skipped cycle", () => {
    const recurring = netflix(history);
    const candidates = [charge("nov", "2026-11-15")];
    expect(
      selectConfirmedAttachments(recurring, candidates, claimedBy(recurring)),
    ).toEqual(["nov"]);
  });

  test("attaches a price change once the new price repeats", () => {
    const recurring = netflix(history);
    const repriced = [
      charge("oct", "2026-10-15", 22.99), // +44%, past the ±25% band
      charge("nov", "2026-11-15", 22.99),
    ];
    // Alone, the repriced charge is indistinguishable from a one-off.
    expect(
      selectConfirmedAttachments(recurring, repriced.slice(0, 1), claimedBy(recurring)),
    ).toEqual([]);
    expect(
      selectConfirmedAttachments(recurring, repriced, claimedBy(recurring)),
    ).toEqual(["oct", "nov"]);
    // Charge by charge, the first new price lands a cycle late, then the
    // ±25% rule tracks the new price.
    expect(
      runIncrementally(recurring, [...repriced, charge("dec", "2026-12-15", 22.99)]),
    ).toEqual(["oct", "nov", "dec"]);
  });

  test("leaves a repriced charge that's also late for a manual add", () => {
    const recurring = netflix(history);
    const candidates = [
      charge("oct-late", "2026-10-27", 22.99),
      charge("nov-late", "2026-11-27", 22.99),
    ];
    expect(
      selectConfirmedAttachments(recurring, candidates, claimedBy(recurring)),
    ).toEqual([]);
  });

  test("leaves a price jump past 2× for a manual add", () => {
    const recurring = netflix(history);
    const candidates = [
      charge("oct", "2026-10-15", 39.99),
      charge("nov", "2026-11-15", 39.99),
    ];
    expect(
      selectConfirmedAttachments(recurring, candidates, claimedBy(recurring)),
    ).toEqual([]);
  });

  test("skips one-off purchases at the same merchant", () => {
    const icloud = (id: string, date: string, amount = 2.99) =>
      charge(id, date, amount, "APPLE.COM");
    const recurring = netflix(
      [icloud("aug", "2026-08-15"), icloud("sep", "2026-09-15")],
      { merchant_key: "apple" },
    );
    const candidates = [
      icloud("app", "2026-10-02", 49.99), // mid-cycle, far off the price
      icloud("movie", "2026-10-14", 5.49), // on the billing date, never repeats
      icloud("oct", "2026-10-15"),
      icloud("app-again", "2026-11-03", 49.99), // repeats, but 17× the bill
    ];
    expect(
      selectConfirmedAttachments(recurring, candidates, claimedBy(recurring)),
    ).toEqual(["oct"]);
  });

  test("a same-priced purchase mid-cycle doesn't block the next charge", () => {
    const prime = (id: string, date: string, amount = 14.99) =>
      charge(id, date, amount, "Amazon Prime");
    const recurring = netflix([prime("sep", "2026-09-01")], {
      merchant_key: "amazon prime",
    });
    const candidates = [prime("order", "2026-09-20", 13), prime("oct", "2026-10-01")];
    // The light gate lets the same-priced order in, but never at the
    // expense of the real charge.
    expect(
      runIncrementally(recurring, candidates),
    ).toEqual(["order", "oct"]);
  });

  test("a single-transaction manual recurring collects later charges", () => {
    // POST /recurrings with one transaction: cadence is only the monthly
    // default, and here the bill is actually weekly.
    const gym = (id: string, date: string) => charge(id, date, 25, "Gym");
    const recurring = netflix([gym("w0", "2026-09-01")], { merchant_key: "gym" });
    const candidates = [
      gym("w1", "2026-09-08"),
      gym("w2", "2026-09-15"),
      gym("w3", "2026-09-22"),
    ];
    expect(
      selectConfirmedAttachments(recurring, candidates, claimedBy(recurring)),
    ).toEqual(["w1", "w2", "w3"]);
  });

  test("only takes unclaimed same-merchant, same-direction charges after the latest member", () => {
    const recurring = netflix(history);
    const other = netflix([charge("elsewhere", "2026-10-20")], {
      merchant_key: "something else",
    });
    const candidates = [
      ...history,
      charge("before", "2026-09-01"),
      charge("same-day", "2026-09-15"),
      charge("refund", "2026-10-01", -15.99),
      charge("hulu", "2026-10-15", 15.99, "Hulu"),
      charge("elsewhere", "2026-10-20"),
      charge("noisy", "2026-10-15", 15.99, "NETFLIX.COM"),
    ];
    expect(
      selectConfirmedAttachments(recurring, candidates, claimedBy(recurring, other)),
    ).toEqual(["noisy"]);
  });

  test("matches income by direction", () => {
    const pay = (id: string, date: string, amount = -3000) =>
      charge(id, date, amount, "Employer Inc");
    const recurring = netflix([pay("sep", "2026-09-30")], {
      merchant_key: "employer inc",
      is_income: true,
    });
    const candidates = [pay("expense", "2026-10-15", 3000), pay("oct", "2026-10-31")];
    expect(
      selectConfirmedAttachments(recurring, candidates, claimedBy(recurring)),
    ).toEqual(["oct"]);
  });

  test("attaches nothing without a live member to measure from", () => {
    const candidates = [charge("oct", "2026-10-15")];
    expect(selectConfirmedAttachments(netflix([]), candidates, new Set())).toEqual([]);
  });
});
