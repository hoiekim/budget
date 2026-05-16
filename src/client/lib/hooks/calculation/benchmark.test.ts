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
describe("extractCashFlows", () => {
  test("classifies cash/deposit (negative-amount Plaid convention) as positive external IN", () => {
    const hs = new HoldingSnapshotDictionary();
    hs.set("hs1", mkHoldingSnap(CASH, 100, 1, null, "2026-01-01"));
    const itxns = new InvestmentTransactionDictionary();
    itxns.set("t1", mkTxn({ date: "2026-02-01", type: InvestmentTransactionType.Cash, subtype: InvestmentTransactionSubtype.Deposit, amount: -500, quantity: 0 }));
    const flows = extractCashFlows(itxns, hs, ACCT);
    expect(flows).toEqual([{ date: "2026-02-01", amount: 500 }]);
  });

  test("classifies cash/withdrawal as negative external OUT", () => {
    const hs = new HoldingSnapshotDictionary();
    hs.set("hs1", mkHoldingSnap(CASH, 100, 1, null, "2026-01-01"));
    const itxns = new InvestmentTransactionDictionary();
    itxns.set("t1", mkTxn({ date: "2026-02-01", type: InvestmentTransactionType.Cash, subtype: InvestmentTransactionSubtype.Withdrawal, amount: 200, quantity: 0 }));
    const flows = extractCashFlows(itxns, hs, ACCT);
    expect(flows).toEqual([{ date: "2026-02-01", amount: -200 }]);
  });

  test("classifies unmatched buy on cash-shape security as external IN", () => {
    const hs = new HoldingSnapshotDictionary();
    hs.set("hs1", mkHoldingSnap(CASH, 100, 1, null, "2026-01-01"));
    const itxns = new InvestmentTransactionDictionary();
    itxns.set("t1", mkTxn({ date: "2026-02-01", type: InvestmentTransactionType.Buy, security_id: CASH, amount: 371, quantity: 371 }));
    const flows = extractCashFlows(itxns, hs, ACCT);
    expect(flows).toEqual([{ date: "2026-02-01", amount: 371 }]);
  });

  test("drops matched buy-cash that has a paired sell-asset within ±7 days (internal sweep move)", () => {
    const hs = new HoldingSnapshotDictionary();
    hs.set("hs1", mkHoldingSnap(CASH, 100, 1, null, "2026-01-01"));
    hs.set("hs2", mkHoldingSnap(VOO, 10, 500, 5000, "2026-01-01"));
    const itxns = new InvestmentTransactionDictionary();
    // Asset SELL on the 1st → matching cash BUY on the 4th. 3-day gap, within ±7d.
    itxns.set("t1", mkTxn({ date: "2026-02-01", type: InvestmentTransactionType.Sell, security_id: VOO, amount: -500, quantity: -1 }));
    itxns.set("t2", mkTxn({ date: "2026-02-04", type: InvestmentTransactionType.Buy, security_id: CASH, amount: 500, quantity: 500 }));
    const flows = extractCashFlows(itxns, hs, ACCT);
    expect(flows).toEqual([]); // both legs dropped as internal
  });

  test("drops matched sell-cash + buy-asset within ±7 days", () => {
    const hs = new HoldingSnapshotDictionary();
    hs.set("hs1", mkHoldingSnap(CASH, 100, 1, null, "2026-01-01"));
    hs.set("hs2", mkHoldingSnap(VOO, 10, 500, 5000, "2026-01-01"));
    const itxns = new InvestmentTransactionDictionary();
    itxns.set("t1", mkTxn({ date: "2026-02-13", type: InvestmentTransactionType.Buy, security_id: VOO, amount: 5044.08, quantity: 8 }));
    // settlement clears 4 days later — was a false positive in the v3 spike (±3d), correctly absorbed at ±7d
    itxns.set("t2", mkTxn({ date: "2026-02-17", type: InvestmentTransactionType.Sell, security_id: CASH, amount: -5044.08, quantity: -5044.08 }));
    const flows = extractCashFlows(itxns, hs, ACCT);
    expect(flows).toEqual([]);
  });

  test("dedupes same-day same-amount cash/deposit + buy-CASH pairs (Plaid double-reporting)", () => {
    const hs = new HoldingSnapshotDictionary();
    hs.set("hs1", mkHoldingSnap(CASH, 100, 1, null, "2026-01-01"));
    const itxns = new InvestmentTransactionDictionary();
    itxns.set("t1", mkTxn({ date: "2026-02-01", type: InvestmentTransactionType.Cash, subtype: InvestmentTransactionSubtype.Deposit, amount: -371, quantity: 0 }));
    itxns.set("t2", mkTxn({ date: "2026-02-01", type: InvestmentTransactionType.Buy, security_id: CASH, amount: 371, quantity: 371 }));
    const flows = extractCashFlows(itxns, hs, ACCT);
    expect(flows).toEqual([{ date: "2026-02-01", amount: 371 }]); // not 742
  });

  test("ignores asset buy/sell (internal reallocation)", () => {
    const hs = new HoldingSnapshotDictionary();
    hs.set("hs1", mkHoldingSnap(VOO, 10, 500, 5000, "2026-01-01"));
    const itxns = new InvestmentTransactionDictionary();
    itxns.set("t1", mkTxn({ date: "2026-02-01", type: InvestmentTransactionType.Buy, security_id: VOO, amount: 500, quantity: 1 }));
    const flows = extractCashFlows(itxns, hs, ACCT);
    expect(flows).toEqual([]);
  });

  test("skips fee/dividend rows (internal returns)", () => {
    const hs = new HoldingSnapshotDictionary();
    hs.set("hs1", mkHoldingSnap(VOO, 10, 500, 5000, "2026-01-01"));
    const itxns = new InvestmentTransactionDictionary();
    itxns.set("t1", mkTxn({ date: "2026-02-01", type: InvestmentTransactionType.Fee, subtype: InvestmentTransactionSubtype.Dividend, security_id: VOO, amount: -25, quantity: 0 }));
    const flows = extractCashFlows(itxns, hs, ACCT);
    expect(flows).toEqual([]);
  });

  test("only considers transactions for the requested account_id", () => {
    const hs = new HoldingSnapshotDictionary();
    hs.set("hs1", mkHoldingSnap(CASH, 100, 1, null, "2026-01-01"));
    const itxns = new InvestmentTransactionDictionary();
    const t = mkTxn({ date: "2026-02-01", type: InvestmentTransactionType.Cash, subtype: InvestmentTransactionSubtype.Deposit, amount: -100, quantity: 0 });
    // Override account_id directly — different account
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

  test("recovers a known 10% annualized rate on a single flow", () => {
    // Deposited $1000 at t=0, ending $1100 a year later, no other flows.
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
    // V_start=0, +1000 deposit at t=0.5y, V_end=1100. Half a year of holding.
    // 1000 * (1+r)^0.5 = 1100  →  r = (1.1)^2 − 1 = 0.21
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

  test("returns no_solution when stream is degenerate (no positive root in range)", () => {
    // V_start=0, no flows, V_end>0 → no rate satisfies. Bisection bounds will be same sign.
    const r = computeMWR({
      flows: [],
      vStart: 0,
      vEnd: 1000,
      windowStart: "2026-01-01",
      windowEnd: "2027-01-01",
    });
    // 0 = 0 + 1000/(1+r)^1. Only solution is r=∞. NPV is positive at all finite r, never crosses zero. → no_solution.
    expect(r.status).toBe("no_solution");
  });

  test("annualized and cumulative agree: cumulative = (1+ann)^years − 1", () => {
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
    expect(r.annualized).toBeCloseTo(0.20, 2); // ~1 year window
  });

  test("annualizes a 6-month +10% return to ~21%", () => {
    const r = computeBenchmarkTWR({
      priceStart: 100,
      priceEnd: 110,
      windowStart: "2026-01-01",
      windowEnd: "2026-07-01",
    });
    expect(r.cumulative).toBeCloseTo(0.10, 6);
    // (1.10)^2 − 1 ≈ 0.21
    expect(r.annualized).toBeCloseTo(0.21, 1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
describe("valueAt + priceAt", () => {
  test("uses latest holding snapshot ≤ date for qty; cash-shape ignores priceAt", () => {
    const hs = new HoldingSnapshotDictionary();
    hs.set("h1", mkHoldingSnap(VOO, 10, 500, 5000, "2026-01-01"));
    hs.set("h2", mkHoldingSnap(VOO, 15, 600, 9000, "2026-03-01"));
    hs.set("h3", mkHoldingSnap(CASH, 200, 1, null, "2026-03-01"));
    const ss = new SecuritySnapshotDictionary();
    ss.set("s1", mkSecuritySnap(VOO, 500, "2026-01-01"));
    ss.set("s2", mkSecuritySnap(VOO, 700, "2026-03-15"));
    const priceAt = buildPriceAt(ss);

    // On 2026-02-15: latest VOO snap is 2026-01-01 (qty=10), latest VOO price is 500.
    // CASH snap not yet observed (only at 2026-03-01), so no cash position yet.
    expect(valueAt({ date: "2026-02-15", accountId: ACCT, holdingSnapshots: hs, priceAt })).toBe(5000);

    // On 2026-04-01: latest VOO snap is 2026-03-01 (qty=15), latest VOO price is 700.
    // CASH snap observed at 2026-03-01 → qty 200 × $1.
    expect(valueAt({ date: "2026-04-01", accountId: ACCT, holdingSnapshots: hs, priceAt })).toBe(15 * 700 + 200);
  });

  test("returns 0 when no holding snapshots exist on or before the date", () => {
    const hs = new HoldingSnapshotDictionary();
    hs.set("h1", mkHoldingSnap(VOO, 10, 500, 5000, "2026-06-01"));
    const ss = new SecuritySnapshotDictionary();
    const priceAt = buildPriceAt(ss);
    expect(valueAt({ date: "2026-01-01", accountId: ACCT, holdingSnapshots: hs, priceAt })).toBe(0);
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
