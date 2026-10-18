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

  test("drops posting dates so one merchant keeps one key", () => {
    expect(normalizeMerchantName("Manual DB-Bkrg 07/03")).toBe("manual db bkrg");
    expect(normalizeMerchantName("Manual DB-Bkrg 10/03")).toBe("manual db bkrg");
    expect(normalizeMerchantName("Utility 03/15/26")).toBe("utility");
  });

  test("keeps slash-separated numbers that aren't dates", () => {
    expect(normalizeMerchantName("24/7 Fitness")).toBe("24 7 fitness");
    expect(normalizeMerchantName("Shop 13/40")).toBe("shop 13 40");
    expect(normalizeMerchantName("Shop 1/2")).toBe("shop 1 2");
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
      amount: [50, 70, 36, 60][i]!,
    }));
    expect(detectRecurringGroups(txns, NOW)).toHaveLength(0);
  });

  test("leaves a one-off charge at another price out of the bill", () => {
    const txns = monthlyTxns("Utility", 5).map((t, i) => ({
      ...t,
      amount: i === 4 ? 100 : 15.99,
    }));
    const groups = detectRecurringGroups(txns, NOW);
    expect(groups.map((g) => g.transaction_ids)).toEqual([
      ["Utility-3", "Utility-2", "Utility-1", "Utility-0"],
    ]);
  });

  test("an old gap or mislabelled charge doesn't disqualify the recent run", () => {
    const mislabelled = ["2025-03-16", "2025-04-14", "2025-05-16", "2025-06-16"].map((date, i) =>
      txn({ transaction_id: `old-${i}`, merchant_name: "YouTube Premium", amount: 2.99, date }),
    );
    const premium = ["2025-07-22", "2025-08-22", "2025-09-22", "2025-10-22", "2025-11-22"].map(
      (date, i) => txn({ transaction_id: `old-premium-${i}`, merchant_name: "YouTube Premium", amount: 22.99, date }),
    );
    const resumed = monthlyTxns("YouTube Premium", 4, 22.99);
    const groups = detectRecurringGroups([...mislabelled, ...premium, ...resumed], NOW);
    expect(groups.map((g) => [g.cadence, g.transaction_ids])).toEqual([
      ["monthly", ["YouTube Premium-3", "YouTube Premium-2", "YouTube Premium-1", "YouTube Premium-0"]],
    ]);
  });

  test("a run that leaves earlier charges out needs four occurrences", () => {
    const irregular = ["2026-01-03", "2026-01-20", "2026-03-02"].map((date, i) =>
      txn({ transaction_id: `early-${i}`, merchant_name: "Corner Shop", amount: 20, date }),
    );
    const monthly = ["2026-07-15", "2026-08-15", "2026-09-15"].map((date, i) =>
      txn({ transaction_id: `m-${i}`, merchant_name: "Corner Shop", amount: 20, date }),
    );
    expect(detectRecurringGroups([...irregular, ...monthly], NOW)).toHaveLength(0);
    expect(detectRecurringGroups(monthly, NOW)).toHaveLength(1);
    const fourth = txn({ transaction_id: "m-3", merchant_name: "Corner Shop", amount: 20, date: "2026-06-15" });
    const groups = detectRecurringGroups([...irregular, fourth, ...monthly], NOW);
    expect(groups.map((g) => g.transaction_ids)).toEqual([["m-3", "m-0", "m-1", "m-2"]]);
  });

  test("a price rise doesn't disqualify the bill", () => {
    const txns = ["03", "04", "05", "06", "07", "08", "09"].map((month, i) =>
      txn({ transaction_id: `s-${month}`, merchant_name: "Streaming", amount: i < 4 ? 10 : 15, date: `2026-${month}-15` }),
    );
    const groups = detectRecurringGroups(txns, NOW);
    expect(groups.map((g) => g.transaction_ids)).toEqual([["s-04", "s-05", "s-06", "s-07", "s-08", "s-09"]]);
  });

  test("a fee keeps losing to the rent when the rent's run is shorter", () => {
    const months = ["01", "02", "03", "04", "05", "06", "07", "08", "09"];
    const rent = months.map((m) =>
      txn({ transaction_id: `rent-${m}`, merchant_name: "Housing", amount: 3900, date: `2026-${m}-${m === "03" ? "10" : "02"}` }),
    );
    const fee = months.map((m) =>
      txn({ transaction_id: `fee-${m}`, merchant_name: "Housing", amount: 2.49, date: `2026-${m}-02` }),
    );
    const groups = detectRecurringGroups([...fee, ...rent], NOW);
    expect(groups.map((g) => g.transaction_ids)).toEqual([
      ["rent-04", "rent-05", "rent-06", "rent-07", "rent-08", "rent-09"],
    ]);
  });

  test("a second plan at twice the price is its own stream", () => {
    const months = ["06", "07", "08", "09"];
    const basic = months.map((m) =>
      txn({ transaction_id: `basic-${m}`, merchant_name: "Phone", amount: 10, date: `2026-${m}-01` }),
    );
    const family = months.map((m) =>
      txn({ transaction_id: `family-${m}`, merchant_name: "Phone", amount: 20, date: `2026-${m}-15` }),
    );
    const groups = detectRecurringGroups([...basic, ...family], NOW);
    expect(groups.map((g) => g.transaction_ids)).toEqual([
      ["family-06", "family-07", "family-08", "family-09"],
    ]);
  });

  test("earlier charges at other prices also call for a fourth occurrence", () => {
    const irregular = [
      ["2026-01-03", 80],
      ["2026-02-20", 95],
      ["2026-04-09", 8],
      ["2026-05-01", 9],
    ].map(([date, amount], i) =>
      txn({ transaction_id: `odd-${i}`, merchant_name: "Corner Shop", amount: amount as number, date: date as string }),
    );
    const monthly = ["2026-07-15", "2026-08-15", "2026-09-15"].map((date, i) =>
      txn({ transaction_id: `m-${i}`, merchant_name: "Corner Shop", amount: 25, date }),
    );
    expect(detectRecurringGroups([...irregular, ...monthly], NOW)).toHaveLength(0);
  });

  test("a fee billed beside the rent never displaces it", () => {
    const rent = monthlyTxns("Housing", 4, 3900);
    const fee = monthlyTxns("Housing", 4, 2.49).map((t) => ({ ...t, transaction_id: `fee-${t.transaction_id}` }));
    const groups = detectRecurringGroups([...fee, ...rent], NOW);
    expect(groups.map((g) => g.transaction_ids)).toEqual([["Housing-3", "Housing-2", "Housing-1", "Housing-0"]]);
  });

  test("a bonus paid on payday stays out of the paycheck run", () => {
    const paychecks = [0, 1, 2, 3].map((i) =>
      txn({
        transaction_id: `pay-${i}`,
        merchant_name: "Employer Payroll",
        amount: -2500,
        date: new Date(2026, 9, 9 - i * 14).toISOString().slice(0, 10),
      }),
    );
    const bonus = txn({ ...paychecks[1]!, transaction_id: "bonus", amount: -11000 });
    const groups = detectRecurringGroups([...paychecks, bonus], NOW);
    expect(groups.map((g) => [g.cadence, g.is_income, g.transaction_ids])).toEqual([
      ["biweekly", true, ["pay-3", "pay-2", "pay-1", "pay-0"]],
    ]);
  });

  test("monthly charges keyed with their posting dates group as one merchant", () => {
    const txns = monthlyTxns("x", 4).map((t) => ({
      ...t,
      merchant_name: null,
      name: `Manual DB-Bkrg ${t.date.slice(5, 7)}/${t.date.slice(8, 10)}`,
    }));
    const groups = detectRecurringGroups(txns, NOW);
    expect(groups.map((g) => [g.merchant_key, g.cadence, g.transaction_ids.length])).toEqual([
      ["manual db bkrg", "monthly", 4],
    ]);
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

  const prime = (id: string, date: string, amount = 14.99) =>
    charge(id, date, amount, "Amazon");

  test("a same-priced purchase mid-cycle neither joins nor blocks the next charge", () => {
    const recurring = netflix([prime("sep", "2026-09-01")], { merchant_key: "amazon" });
    const candidates = [prime("order", "2026-09-20", 13), prime("oct", "2026-10-01")];
    // One member, so no measured cadence yet, but the order lands on no
    // cadence's schedule, so only the real charge joins.
    expect(runIncrementally(recurring, candidates)).toEqual(["oct"]);
  });

  test("same-priced purchases off the billing schedule stay out", () => {
    const recurring = netflix(
      [prime("aug", "2026-08-01"), prime("sep", "2026-09-01")],
      { merchant_key: "amazon" },
    );
    const candidates = [
      prime("book", "2026-09-12", 12.5),
      prime("charger", "2026-09-24", 17),
      prime("oct", "2026-10-01"),
      prime("cable", "2026-10-18", 15),
      prime("nov", "2026-11-01"),
    ];
    expect(
      selectConfirmedAttachments(recurring, candidates, claimedBy(recurring)),
    ).toEqual(["oct", "nov"]);
  });

  test("of two charges due in the same cycle, the one closest to the due date joins", () => {
    const recurring = netflix(
      [prime("aug", "2026-08-01"), prime("sep", "2026-09-01")],
      { merchant_key: "amazon" },
    );
    // Both within tolerance of Oct 1; the purchase is 3 days early.
    const candidates = [prime("order", "2026-09-28", 14), prime("oct", "2026-10-01")];
    expect(
      selectConfirmedAttachments(recurring, candidates, claimedBy(recurring)),
    ).toEqual(["oct"]);
  });

  test("the price window can't drift on a run of nearby purchases", () => {
    const recurring = netflix(
      [prime("aug", "2026-08-01"), prime("sep", "2026-09-01")],
      { merchant_key: "amazon" },
    );
    const candidates = [
      prime("a", "2026-09-10", 18),
      prime("b", "2026-09-17", 22),
      prime("c", "2026-09-24", 27),
      prime("oct", "2026-10-01"),
    ];
    expect(
      selectConfirmedAttachments(recurring, candidates, claimedBy(recurring)),
    ).toEqual(["oct"]);
  });

  test("a qualifying group brings in the merchant's history, whatever its dates", () => {
    // Created by hand from October's charge only; detection still finds the
    // whole run qualifying.
    const recurring = netflix([charge("oct", "2026-10-15")]);
    const candidates = [...history, charge("oct", "2026-10-15")];
    const group = { transaction_ids: ["jul", "aug", "sep", "oct"] };
    expect(
      selectConfirmedAttachments(recurring, candidates, claimedBy(recurring), group),
    ).toEqual(["jul", "aug", "sep"]);
  });

  test("a charge that syncs late with an earlier date joins through its group", () => {
    const recurring = netflix([history[0]!, history[2]!, charge("oct", "2026-10-15")]);
    const candidates = [...history, charge("oct", "2026-10-15")];
    const group = { transaction_ids: ["jul", "aug", "sep", "oct"] };
    expect(
      selectConfirmedAttachments(
        recurring,
        candidates,
        claimedBy(recurring),
        group,
      ),
    ).toEqual(["aug"]);
  });

  test("a group billed at another price doesn't join", () => {
    const recurring = netflix([
      charge("jul", "2026-07-15", 2.99),
      charge("aug", "2026-08-15", 2.99),
      charge("sep", "2026-09-15", 2.99),
    ]);
    const other = ["06", "07", "08", "09"].map((m) => charge(`plus-${m}`, `2026-${m}-20`, 10.99));
    const candidates = [...recurring.members.map((m) => charge(m.transaction_id, m.date, 2.99)), ...other];
    const [group] = detectRecurringGroups(candidates, NOW);
    expect(group!.transaction_ids).toEqual(["plus-06", "plus-07", "plus-08", "plus-09"]);
    expect(
      selectConfirmedAttachments(recurring, candidates, claimedBy(recurring), group),
    ).toEqual([]);
  });

  test("group charges already claimed elsewhere stay put", () => {
    const recurring = netflix([charge("oct", "2026-10-15")]);
    const candidates = [...history, charge("oct", "2026-10-15")];
    const group = { transaction_ids: ["jul", "aug", "sep", "oct"] };
    const claimed = new Set(["oct", "aug"]);
    expect(selectConfirmedAttachments(recurring, candidates, claimed, group)).toEqual([
      "jul",
      "sep",
    ]);
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
