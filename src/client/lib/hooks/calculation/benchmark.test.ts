// Run with: bun test --preload ./test-preload.ts benchmark.test.ts
import { describe, test, expect } from "bun:test";
import { InvestmentTransactionType, InvestmentTransactionSubtype } from "plaid";

import {
  extractCashFlows,
  computeMWR,
  computeBenchmarkTWR,
  valueAt,
  buildPriceAt,
  findBenchmarkSecurityId,
  firstPricedSnapshotDate,
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
    const ss = new SecuritySnapshotDictionary();
    ss.set("s1", mkSecuritySnap(VOO, 500, "2026-01-01"));
    const itxns = new InvestmentTransactionDictionary();
    const priceAt = buildPriceAt(ss);

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
    const ss = new SecuritySnapshotDictionary();
    ss.set("s1", mkSecuritySnap(VOO, 500, "2026-01-01"));
    ss.set("s2", mkSecuritySnap(VOO, 600, "2026-06-01"));
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
    const priceAt = buildPriceAt(ss);

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
    const ss = new SecuritySnapshotDictionary();
    const itxns = new InvestmentTransactionDictionary();
    const priceAt = buildPriceAt(ss);
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
    const ss = new SecuritySnapshotDictionary();
    const itxns = new InvestmentTransactionDictionary();
    const priceAt = buildPriceAt(ss);
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
    // User had nothing at windowStart, bought 5 shares in window.
    const hs = new HoldingSnapshotDictionary();
    const ss = new SecuritySnapshotDictionary();
    ss.set("s1", mkSecuritySnap(VOO, 500, "2026-01-01"));
    ss.set("s2", mkSecuritySnap(VOO, 600, "2026-06-01"));
    const itxns = new InvestmentTransactionDictionary();
    itxns.set(
      "t1",
      mkTxn({
        date: "2026-03-01",
        type: InvestmentTransactionType.Buy,
        security_id: VOO,
        amount: 2500,
        quantity: 5,
      }),
    );
    const priceAt = buildPriceAt(ss);

    expect(
      valueAt({
        date: "2026-06-01",
        windowStart: "2026-01-01",
        accountId: ACCT,
        holdingSnapshots: hs,
        investmentTransactions: itxns,
        priceAt,
      }),
    ).toBe(5 * 600);
  });

  test("buildPriceAt returns null when no snapshot exists for the security", () => {
    const ss = new SecuritySnapshotDictionary();
    const priceAt = buildPriceAt(ss);
    expect(priceAt(VOO, "2026-01-01")).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
describe("findBenchmarkSecurityId", () => {
  test("returns matching security_id for ticker", () => {
    const ss = new SecuritySnapshotDictionary();
    ss.set("s1", mkSecuritySnap(VOO, 500, "2026-01-01", "VOO"));
    ss.set("s2", mkSecuritySnap("sec-spy", 480, "2026-01-01", "SPY"));
    expect(findBenchmarkSecurityId(ss, "VOO")).toBe(VOO);
    expect(findBenchmarkSecurityId(ss, "SPY")).toBe("sec-spy");
  });

  test("returns null when ticker not found", () => {
    const ss = new SecuritySnapshotDictionary();
    expect(findBenchmarkSecurityId(ss, "AAPL")).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
describe("firstPricedSnapshotDate", () => {
  test("returns earliest snapshot date for a security_id", () => {
    const ss = new SecuritySnapshotDictionary();
    ss.set("s1", mkSecuritySnap(VOO, 500, "2025-06-05", "VOO"));
    ss.set("s2", mkSecuritySnap(VOO, 520, "2025-12-01", "VOO"));
    ss.set("s3", mkSecuritySnap(VOO, 530, "2026-05-16", "VOO"));
    expect(firstPricedSnapshotDate(ss, VOO)).toBe("2025-06-05");
  });

  test("ignores other securities", () => {
    const ss = new SecuritySnapshotDictionary();
    ss.set("s1", mkSecuritySnap(VOO, 500, "2025-06-05", "VOO"));
    ss.set("s2", mkSecuritySnap("sec-spy", 480, "2020-01-01", "SPY"));
    expect(firstPricedSnapshotDate(ss, VOO)).toBe("2025-06-05");
  });

  test("skips snapshots with null close_price", () => {
    const ss = new SecuritySnapshotDictionary();
    ss.set(
      "s1",
      new SecuritySnapshot({
        snapshot: { snapshot_id: "ss_null", date: "2024-01-01" },
        security: {
          security_id: VOO,
          ticker_symbol: "VOO",
          close_price: null,
          close_price_as_of: "2024-01-01",
        },
      }),
    );
    ss.set("s2", mkSecuritySnap(VOO, 500, "2025-06-05", "VOO"));
    expect(firstPricedSnapshotDate(ss, VOO)).toBe("2025-06-05");
  });

  test("returns null when no snapshots", () => {
    const ss = new SecuritySnapshotDictionary();
    expect(firstPricedSnapshotDate(ss, VOO)).toBeNull();
  });
});
