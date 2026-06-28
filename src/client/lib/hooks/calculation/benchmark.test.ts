// Run with: bun test --preload ./test-preload.ts benchmark.test.ts
import { describe, test, expect } from "bun:test";
import { InvestmentTransactionType, InvestmentTransactionSubtype } from "plaid";

import {
  extractCashFlows,
  extractCashFlowsBySecurity,
  computeMWR,
  computeBenchmarkTWR,
  valueAt,
  buildPriceAt,
  priceAtIn,
  buildBenchmarkPriceAt,
  computeHoldingBenchmark,
  type PriceRow,
} from "./benchmark";
import {
  HoldingSnapshotDictionary,
  SecuritySnapshotDictionary,
  InvestmentTransactionDictionary,
} from "../../models/Data";
import { HoldingSnapshot, SecuritySnapshot } from "../../models/Snapshot";
import { InvestmentTransaction } from "../../models/InvestmentTransaction";

const ACCT = "acc-1";
const VOO = "sec-voo";
const CASH = "sec-cash";

const mkHoldingSnap = (sid: string, qty: number, instPrice: number, costBasis: number | null, date: string) =>
  new HoldingSnapshot({
    snapshot: { snapshot_id: `hs_${sid}_${date}`, date },
    holding: {
      account_id: ACCT,
      security_id: sid,
      quantity: qty,
      institution_price: instPrice,
      institution_value: qty * instPrice,
      cost_basis: costBasis,
      institution_price_as_of: date,
      iso_currency_code: "USD",
      unofficial_currency_code: null,
    },
  });

const mkSecuritySnap = (sid: string, closePrice: number, date: string, ticker = "TICK") =>
  new SecuritySnapshot({
    snapshot: { snapshot_id: `ss_${sid}_${date}`, date },
    security: {
      security_id: sid,
      ticker_symbol: ticker,
      close_price: closePrice,
      close_price_as_of: date,
    },
  });

const mkTxn = (overrides: Partial<InvestmentTransaction> & { date: string; amount: number }): InvestmentTransaction =>
  new InvestmentTransaction({
    investment_transaction_id: `tx_${Math.random()}`,
    account_id: ACCT,
    security_id: VOO,
    type: InvestmentTransactionType.Buy,
    subtype: InvestmentTransactionSubtype.Buy,
    quantity: 1,
    price: overrides.amount,
    name: "test",
    ...overrides,
  });

// ──────────────────────────────────────────────────────────────────────────────
describe("extractCashFlows (cash-excluded model)", () => {
  test("classifies asset BUY as external IN", () => {
    const hs = new HoldingSnapshotDictionary();
    hs.set("h1", mkHoldingSnap(VOO, 10, 500, 5000, "2026-01-01"));
    const itxns = new InvestmentTransactionDictionary();
    itxns.set("t1", mkTxn({ date: "2026-02-01", type: InvestmentTransactionType.Buy, security_id: VOO, amount: 569, quantity: 1 }));
    expect(extractCashFlows(itxns, hs, ACCT)).toEqual([{ date: "2026-02-01", amount: 569 }]);
  });

  test("classifies asset SELL as external OUT", () => {
    const hs = new HoldingSnapshotDictionary();
    hs.set("h1", mkHoldingSnap(VOO, 10, 500, 5000, "2026-01-01"));
    const itxns = new InvestmentTransactionDictionary();
    itxns.set("t1", mkTxn({ date: "2026-02-01", type: InvestmentTransactionType.Sell, security_id: VOO, amount: 569, quantity: -1 }));
    expect(extractCashFlows(itxns, hs, ACCT)).toEqual([{ date: "2026-02-01", amount: -569 }]);
  });

  test("ignores cash-shape security buy/sell entirely (cash side, not asset side)", () => {
    const hs = new HoldingSnapshotDictionary();
    hs.set("h1", mkHoldingSnap(CASH, 100, 1, null, "2026-01-01"));
    const itxns = new InvestmentTransactionDictionary();
    itxns.set("t1", mkTxn({ date: "2026-02-01", type: InvestmentTransactionType.Buy, security_id: CASH, amount: 371, quantity: 371 }));
    itxns.set("t2", mkTxn({ date: "2026-02-05", type: InvestmentTransactionType.Sell, security_id: CASH, amount: 200, quantity: -200 }));
    expect(extractCashFlows(itxns, hs, ACCT)).toEqual([]);
  });

  test("ignores cash/deposit and cash/withdrawal events", () => {
    const hs = new HoldingSnapshotDictionary();
    hs.set("h1", mkHoldingSnap(VOO, 10, 500, 5000, "2026-01-01"));
    const itxns = new InvestmentTransactionDictionary();
    itxns.set("t1", mkTxn({ date: "2026-02-01", type: InvestmentTransactionType.Cash, subtype: InvestmentTransactionSubtype.Deposit, amount: -500, quantity: 0 }));
    itxns.set("t2", mkTxn({ date: "2026-02-02", type: InvestmentTransactionType.Cash, subtype: InvestmentTransactionSubtype.Withdrawal, amount: 200, quantity: 0 }));
    expect(extractCashFlows(itxns, hs, ACCT)).toEqual([]);
  });

  test("ignores fee/dividend rows", () => {
    const hs = new HoldingSnapshotDictionary();
    hs.set("h1", mkHoldingSnap(VOO, 10, 500, 5000, "2026-01-01"));
    const itxns = new InvestmentTransactionDictionary();
    itxns.set("t1", mkTxn({ date: "2026-02-01", type: InvestmentTransactionType.Fee, subtype: InvestmentTransactionSubtype.Dividend, security_id: VOO, amount: -25, quantity: 0 }));
    expect(extractCashFlows(itxns, hs, ACCT)).toEqual([]);
  });

  test("ignores qty=0 rows (Plaid sometimes records non-trade events as buy/sell with qty=0)", () => {
    const hs = new HoldingSnapshotDictionary();
    hs.set("h1", mkHoldingSnap(VOO, 10, 500, 5000, "2026-01-01"));
    const itxns = new InvestmentTransactionDictionary();
    itxns.set("t1", mkTxn({ date: "2026-02-01", type: InvestmentTransactionType.Sell, security_id: VOO, amount: -3600, quantity: 0 }));
    expect(extractCashFlows(itxns, hs, ACCT)).toEqual([]);
  });

  test("sums multiple same-day asset flows", () => {
    const hs = new HoldingSnapshotDictionary();
    hs.set("h1", mkHoldingSnap(VOO, 10, 500, 5000, "2026-01-01"));
    const itxns = new InvestmentTransactionDictionary();
    itxns.set("t1", mkTxn({ date: "2026-02-01", type: InvestmentTransactionType.Buy, security_id: VOO, amount: 569, quantity: 1 }));
    itxns.set("t2", mkTxn({ date: "2026-02-01", type: InvestmentTransactionType.Buy, security_id: VOO, amount: 141, quantity: 0.25 }));
    expect(extractCashFlows(itxns, hs, ACCT)).toEqual([{ date: "2026-02-01", amount: 710 }]);
  });

  test("only considers transactions for the requested account_id", () => {
    const hs = new HoldingSnapshotDictionary();
    hs.set("h1", mkHoldingSnap(VOO, 10, 500, 5000, "2026-01-01"));
    const itxns = new InvestmentTransactionDictionary();
    const t = mkTxn({ date: "2026-02-01", type: InvestmentTransactionType.Buy, security_id: VOO, amount: 500, quantity: 1 });
    (t as { account_id: string }).account_id = "other";
    itxns.set("t1", t);
    expect(extractCashFlows(itxns, hs, ACCT)).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
describe("computeMWR", () => {
  test("returns 0% when V_end == V_start with no flows", () => {
    const r = computeMWR({
      flows: [],
      vStart: 1000,
      vEnd: 1000,
      windowStart: "2026-01-01",
      windowEnd: "2027-01-01",
    });
    expect(r.status).toBe("ok");
    expect(Math.abs(r.annualized!)).toBeLessThan(0.001);
  });

  test("recovers a known 10% annualized rate over a 1y window", () => {
    const r = computeMWR({
      flows: [],
      vStart: 1000,
      vEnd: 1100,
      windowStart: "2026-01-01",
      windowEnd: "2027-01-01",
    });
    expect(r.status).toBe("ok");
    expect(r.annualized!).toBeCloseTo(0.10, 2);
  });

  test("recovers IRR with mid-period contribution", () => {
    // V_start=0, +1000 deposit at t=0.5y, V_end=1100.
    // 1000 × (1+r)^0.5 = 1100 → r ≈ 0.21
    const r = computeMWR({
      flows: [{ date: "2026-07-01", amount: 1000 }],
      vStart: 0,
      vEnd: 1100,
      windowStart: "2026-01-01",
      windowEnd: "2027-01-01",
    });
    expect(r.status).toBe("ok");
    expect(r.annualized!).toBeCloseTo(0.21, 1);
  });

  test("returns no_solution when stream is degenerate (no root in range)", () => {
    const r = computeMWR({
      flows: [],
      vStart: 0,
      vEnd: 1000,
      windowStart: "2026-01-01",
      windowEnd: "2027-01-01",
    });
    expect(r.status).toBe("no_solution");
  });

  test("returns no_solution when portfolio is empty at both boundaries (regression for #390)", () => {
    // Manual investment account with no investment_transactions and no
    // priced security_snapshots: valueAt returns 0 at both ends, flows is
    // empty. Pre-fix this returned annualized=-0.99 (a fake −99% return)
    // because the bisection converged on its lower bound.
    const r = computeMWR({
      flows: [],
      vStart: 0,
      vEnd: 0,
      windowStart: "2025-05-18",
      windowEnd: "2026-05-18",
    });
    expect(r.status).toBe("no_solution");
    expect(r.annualized).toBeNull();
    expect(r.cumulative).toBeNull();
  });

  test("cumulative = (1 + annualized)^years − 1", () => {
    const r = computeMWR({
      flows: [{ date: "2026-04-01", amount: 500 }],
      vStart: 1000,
      vEnd: 1700,
      windowStart: "2026-01-01",
      windowEnd: "2026-12-31",
    });
    const years = (new Date("2026-12-31").getTime() - new Date("2026-01-01").getTime()) / (1000 * 60 * 60 * 24 * 365);
    expect(r.cumulative!).toBeCloseTo(Math.pow(1 + r.annualized!, years) - 1, 6);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
describe("computeBenchmarkTWR", () => {
  test("simple price ratio gives cumulative; annualization matches the years formula", () => {
    const r = computeBenchmarkTWR({
      priceStart: 100,
      priceEnd: 120,
      windowStart: "2026-01-01",
      windowEnd: "2027-01-01",
    });
    expect(r.cumulative).toBeCloseTo(0.20, 6);
    expect(r.annualized).toBeCloseTo(0.20, 2);
  });

  test("annualizes a 6-month +10% return to ~21%", () => {
    const r = computeBenchmarkTWR({
      priceStart: 100,
      priceEnd: 110,
      windowStart: "2026-01-01",
      windowEnd: "2026-07-01",
    });
    expect(r.cumulative).toBeCloseTo(0.10, 6);
    expect(r.annualized).toBeCloseTo(0.21, 1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
describe("valueAt (asset-only, txn-derived qty)", () => {
  test("V_start uses holding-snap qty as the anchor; cash-shape excluded", () => {
    const hs = new HoldingSnapshotDictionary();
    hs.set("h1", mkHoldingSnap(VOO, 10, 500, 5000, "2026-01-01"));
    hs.set("h3", mkHoldingSnap(CASH, 200, 1, null, "2026-01-01"));
    const itxns = new InvestmentTransactionDictionary();
    // A pre-window buy gives priceAt(VOO, 2026-01-01) a $500 data point.
    itxns.set(
      "t0",
      mkTxn({
        date: "2025-12-01",
        type: InvestmentTransactionType.Buy,
        security_id: VOO,
        amount: 500,
        quantity: 1,
        price: 500,
      } as Parameters<typeof mkTxn>[0]),
    );
    const ss = new SecuritySnapshotDictionary();
    const priceAt = buildPriceAt(ss, itxns);

    expect(
      valueAt({
        date: "2026-01-01",
        windowStart: "2026-01-01",
        accountId: ACCT,
        holdingSnapshots: hs,
        investmentTransactions: itxns,
        priceAt,
      }),
    ).toBe(5000); // 10 × 500, cash excluded
  });

  test("V_end uses anchor + Σ(buy − sell) within window — phantom holding shares are invisible", () => {
    // Anchor: 10 shares VOO at start. Within window: 5 buys of 1 share each.
    // Holding snap at end shows 100 shares (Plaid sync glitch — txns lag).
    // valueAt should ignore the phantom shares and report 10 + 5 = 15 × price.
    const hs = new HoldingSnapshotDictionary();
    hs.set("h1", mkHoldingSnap(VOO, 10, 500, 5000, "2026-01-01"));
    hs.set("h2", mkHoldingSnap(VOO, 100, 600, 60000, "2026-06-01")); // phantom +90 shares
    const itxns = new InvestmentTransactionDictionary();
    // 5 buys, all dated before the query date (2026-06-01).
    const buyDates = ["2026-02-10", "2026-03-10", "2026-04-10", "2026-05-10", "2026-05-25"];
    buyDates.forEach((date, i) => {
      itxns.set(
        `t${i}`,
        mkTxn({
          date,
          type: InvestmentTransactionType.Buy,
          security_id: VOO,
          amount: 600,
          quantity: 1,
        }),
      );
    });
    const ss = new SecuritySnapshotDictionary();
    const priceAt = buildPriceAt(ss, itxns);

    expect(
      valueAt({
        date: "2026-06-01",
        windowStart: "2026-01-01",
        accountId: ACCT,
        holdingSnapshots: hs,
        investmentTransactions: itxns,
        priceAt,
      }),
    ).toBe(15 * 600); // 9000 (10 anchor + 5 buys), NOT 60000
  });

  test("returns 0 when only cash-shape holdings exist", () => {
    const hs = new HoldingSnapshotDictionary();
    hs.set("h1", mkHoldingSnap(CASH, 5000, 1, null, "2026-01-01"));
    const itxns = new InvestmentTransactionDictionary();
    const ss = new SecuritySnapshotDictionary();
    const priceAt = buildPriceAt(ss, itxns);
    expect(
      valueAt({
        date: "2026-02-01",
        windowStart: "2026-01-01",
        accountId: ACCT,
        holdingSnapshots: hs,
        investmentTransactions: itxns,
        priceAt,
      }),
    ).toBe(0);
  });

  test("returns 0 when no holding snapshots ≤ windowStart", () => {
    const hs = new HoldingSnapshotDictionary();
    hs.set("h1", mkHoldingSnap(VOO, 10, 500, 5000, "2026-06-01"));
    const itxns = new InvestmentTransactionDictionary();
    const ss = new SecuritySnapshotDictionary();
    const priceAt = buildPriceAt(ss, itxns);
    expect(
      valueAt({
        date: "2026-01-15",
        windowStart: "2026-01-01",
        accountId: ACCT,
        holdingSnapshots: hs,
        investmentTransactions: itxns,
        priceAt,
      }),
    ).toBe(0);
  });

  test("includes a security with zero anchor but new txns within window", () => {
    // User had nothing at windowStart, bought 5 shares in window at $500
    // (March) and the price reference at query time (2026-06-01) walks
    // back through txn prices to that buy → 5 × $500 = $2500.
    const hs = new HoldingSnapshotDictionary();
    const itxns = new InvestmentTransactionDictionary();
    itxns.set(
      "t1",
      mkTxn({
        date: "2026-03-01",
        type: InvestmentTransactionType.Buy,
        security_id: VOO,
        amount: 2500,
        quantity: 5,
        price: 500,
      } as Parameters<typeof mkTxn>[0]),
    );
    const ss = new SecuritySnapshotDictionary();
    const priceAt = buildPriceAt(ss, itxns);

    expect(
      valueAt({
        date: "2026-06-01",
        windowStart: "2026-01-01",
        accountId: ACCT,
        holdingSnapshots: hs,
        investmentTransactions: itxns,
        priceAt,
      }),
    ).toBe(5 * 500);
  });

  test("buildPriceAt returns null when no txn exists for the security", () => {
    const itxns = new InvestmentTransactionDictionary();
    const ss = new SecuritySnapshotDictionary();
    const priceAt = buildPriceAt(ss, itxns);
    expect(priceAt(VOO, "2026-01-01")).toBeNull();
  });

  test("buildPriceAt walks back to the latest txn ≤ query date", () => {
    const itxns = new InvestmentTransactionDictionary();
    itxns.set(
      "t1",
      mkTxn({
        date: "2023-05-03",
        type: InvestmentTransactionType.Buy,
        security_id: VOO,
        amount: 390,
        quantity: 1,
        price: 390,
      } as Parameters<typeof mkTxn>[0]),
    );
    itxns.set(
      "t2",
      mkTxn({
        date: "2025-05-05",
        type: InvestmentTransactionType.Buy,
        security_id: VOO,
        amount: 519,
        quantity: 1,
        price: 519,
      } as Parameters<typeof mkTxn>[0]),
    );

    const ss = new SecuritySnapshotDictionary();
    const priceAt = buildPriceAt(ss, itxns);
    expect(priceAt(VOO, "2023-05-17")).toBe(390); // walk-back to t1
    expect(priceAt(VOO, "2025-12-01")).toBe(519); // walk-back to t2
    // Pre-history fallback: query predates everything → earliest known.
    expect(priceAt(VOO, "2020-01-01")).toBe(390);
  });

  test("buildPriceAt merges snapshot + txn sources, latest-date wins", () => {
    // Snapshot at 2025-06-05 ($545), txn at 2025-05-05 ($519). Both
    // exist for the same security; walk-back to a date past both should
    // pick the later (snapshot). Walk-back to a date past only the
    // earlier should pick the earlier (txn).
    const ss = new SecuritySnapshotDictionary();
    ss.set("s1", mkSecuritySnap(VOO, 545, "2025-06-05"));
    const itxns = new InvestmentTransactionDictionary();
    itxns.set(
      "t1",
      mkTxn({
        date: "2025-05-05",
        type: InvestmentTransactionType.Buy,
        security_id: VOO,
        amount: 519,
        quantity: 1,
        price: 519,
      } as Parameters<typeof mkTxn>[0]),
    );
    const priceAt = buildPriceAt(ss, itxns);
    expect(priceAt(VOO, "2025-07-01")).toBe(545); // snapshot wins
    expect(priceAt(VOO, "2025-05-15")).toBe(519); // only txn ≤ this date
  });

  test("buildPriceAt ignores non-asset txn types (dividend, cash, fee)", () => {
    const itxns = new InvestmentTransactionDictionary();
    // Dividend txn with a non-zero price field — must be ignored.
    itxns.set(
      "t1",
      mkTxn({
        date: "2024-01-01",
        type: InvestmentTransactionType.Fee,
        subtype: InvestmentTransactionSubtype.Dividend,
        security_id: VOO,
        amount: 50,
        quantity: 0.1,
        price: 999, // bogus marker — must not propagate into priceAt
      } as Parameters<typeof mkTxn>[0]),
    );
    const ss = new SecuritySnapshotDictionary();
    const priceAt = buildPriceAt(ss, itxns);
    expect(priceAt(VOO, "2024-06-01")).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
describe("extractCashFlowsBySecurity", () => {
  test("groups signed flows per security, excludes cash, sums same-day", () => {
    const hs = new HoldingSnapshotDictionary();
    hs.set("h1", mkHoldingSnap(CASH, 100, 1, null, "2026-01-01")); // cash-shape
    const itxns = new InvestmentTransactionDictionary();
    itxns.set("t1", mkTxn({ date: "2026-02-01", type: InvestmentTransactionType.Buy, security_id: VOO, amount: 100, quantity: 1 }));
    itxns.set("t2", mkTxn({ date: "2026-02-01", type: InvestmentTransactionType.Buy, security_id: VOO, amount: 50, quantity: 1 }));
    itxns.set("t3", mkTxn({ date: "2026-03-01", type: InvestmentTransactionType.Sell, security_id: VOO, amount: 30, quantity: -1 }));
    itxns.set("t4", mkTxn({ date: "2026-02-10", type: InvestmentTransactionType.Buy, security_id: "sec-qqq", amount: 200, quantity: 1 }));
    itxns.set("t5", mkTxn({ date: "2026-02-15", type: InvestmentTransactionType.Buy, security_id: CASH, amount: 500, quantity: 500 }));

    const bySec = extractCashFlowsBySecurity(itxns, hs, ACCT);
    expect(bySec.get(VOO)).toEqual([
      { date: "2026-02-01", amount: 150 }, // same-day buys summed
      { date: "2026-03-01", amount: -30 }, // sell signed negative
    ]);
    expect(bySec.get("sec-qqq")).toEqual([{ date: "2026-02-10", amount: 200 }]);
    expect(bySec.has(CASH)).toBe(false); // cash-shape excluded
  });
});

describe("extractCashFlows securityIds filter", () => {
  test("keeps only flows for the requested securities", () => {
    const hs = new HoldingSnapshotDictionary();
    const itxns = new InvestmentTransactionDictionary();
    itxns.set("t1", mkTxn({ date: "2026-02-01", type: InvestmentTransactionType.Buy, security_id: VOO, amount: 100, quantity: 1 }));
    itxns.set("t2", mkTxn({ date: "2026-02-01", type: InvestmentTransactionType.Buy, security_id: "sec-qqq", amount: 200, quantity: 1 }));

    // Unfiltered sums both into one same-day flow.
    expect(extractCashFlows(itxns, hs, ACCT)).toEqual([{ date: "2026-02-01", amount: 300 }]);
    // Filtered to VOO only.
    expect(extractCashFlows(itxns, hs, ACCT, new Set([VOO]))).toEqual([{ date: "2026-02-01", amount: 100 }]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
describe("priceAtIn", () => {
  const history: PriceRow[] = [
    { date: "2024-01-01", close: 100 },
    { date: "2025-01-01", close: 200 },
    { date: "2026-01-01", close: 400 },
  ];
  test("returns latest close ≤ date", () => {
    expect(priceAtIn(history, "2025-06-01")).toBe(200);
    expect(priceAtIn(history, "2026-01-01")).toBe(400);
  });
  test("null before history starts; empty history null", () => {
    expect(priceAtIn(history, "2023-12-31")).toBeNull();
    expect(priceAtIn([], "2025-01-01")).toBeNull();
  });
});

describe("buildBenchmarkPriceAt", () => {
  test("snapshot wins; CSV fills the historical tail; null when neither has it", () => {
    const ss = new SecuritySnapshotDictionary();
    ss.set("s1", mkSecuritySnap(VOO, 300, "2025-07-01", "VOO"));
    const csv: PriceRow[] = [
      { date: "2020-01-01", close: 100 },
      { date: "2021-01-01", close: 150 },
    ];
    const priceAt = buildBenchmarkPriceAt(ss, csv, "VOO");
    expect(priceAt("2025-07-01")).toBe(300); // snapshot
    expect(priceAt("2020-06-01")).toBe(100); // CSV fallback (no snapshot ≤ date)
    expect(priceAt("2019-01-01")).toBeNull(); // predates everything
  });
  test("no snapshot for ticker → CSV only", () => {
    const ss = new SecuritySnapshotDictionary();
    const csv: PriceRow[] = [{ date: "2024-01-01", close: 100 }];
    const priceAt = buildBenchmarkPriceAt(ss, csv, "VOO");
    expect(priceAt("2024-06-01")).toBe(100);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
describe("computeHoldingBenchmark (dynamic distribution, #317)", () => {
  // VOO doubled then doubled again: 100 → 200 → 400.
  const priceAt = (date: string): number | null => {
    if (date >= "2026-01-01") return 400;
    if (date >= "2025-01-01") return 200;
    if (date >= "2024-01-01") return 100;
    return null;
  };

  test("single contribution: simple price ratio", () => {
    const r = computeHoldingBenchmark({
      contributions: [{ date: "2024-01-01", amount: 1000 }],
      asOf: "2026-01-01",
      benchmarkPriceAt: priceAt,
    });
    expect(r).not.toBeNull();
    expect(r!.gain).toBeCloseTo(3000, 6); // 1000×(400/100) − 1000
    expect(r!.returnPercent).toBeCloseTo(300, 6);
  });

  test("uneven contributions are re-priced at their OWN dates (no averaging)", () => {
    const r = computeHoldingBenchmark({
      contributions: [
        { date: "2024-01-01", amount: 1000 }, // ×4
        { date: "2025-01-01", amount: 1000 }, // ×2
      ],
      asOf: "2026-01-01",
      benchmarkPriceAt: priceAt,
    });
    // hypothetical = 4000 + 2000 = 6000; net = 2000; gain = 4000; pct = 200%.
    // Averaging the dates (→ a single mid-window entry) would NOT give this.
    expect(r!.gain).toBeCloseTo(4000, 6);
    expect(r!.returnPercent).toBeCloseTo(200, 6);
  });

  test("sell (negative contribution) reduces net and hypothetical", () => {
    const r = computeHoldingBenchmark({
      contributions: [
        { date: "2024-01-01", amount: 1000 }, // ×4 → 4000
        { date: "2025-01-01", amount: -500 }, // ×2 → -1000
      ],
      asOf: "2026-01-01",
      benchmarkPriceAt: priceAt,
    });
    // hypothetical = 4000 − 1000 = 3000; net = 500; gain = 2500; pct = 500%.
    expect(r!.gain).toBeCloseTo(2500, 6);
    expect(r!.returnPercent).toBeCloseTo(500, 6);
  });

  test("null on: no contributions, net ≤ 0, missing contribution price, missing asOf price", () => {
    expect(
      computeHoldingBenchmark({ contributions: [], asOf: "2026-01-01", benchmarkPriceAt: priceAt }),
    ).toBeNull();
    // Net zero (fully closed) → can't express a %-return.
    expect(
      computeHoldingBenchmark({
        contributions: [
          { date: "2024-01-01", amount: 1000 },
          { date: "2025-01-01", amount: -1000 },
        ],
        asOf: "2026-01-01",
        benchmarkPriceAt: priceAt,
      }),
    ).toBeNull();
    // Contribution predates available index history.
    expect(
      computeHoldingBenchmark({
        contributions: [{ date: "2023-01-01", amount: 1000 }],
        asOf: "2026-01-01",
        benchmarkPriceAt: priceAt,
      }),
    ).toBeNull();
    // asOf has no index price.
    expect(
      computeHoldingBenchmark({
        contributions: [{ date: "2024-01-01", amount: 1000 }],
        asOf: "2023-06-01",
        benchmarkPriceAt: priceAt,
      }),
    ).toBeNull();
  });
});