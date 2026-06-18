// Run with: bun test --preload ./test-preload.ts holdings.test.ts
import { describe, test, expect } from "bun:test";
import { InvestmentTransactionType, InvestmentTransactionSubtype } from "plaid";

import {
  buildSecurityPriceIndex,
  getPriceForHolding,
  inferCostBasis,
  getHoldingsValueData,
  getEarningsForPeriod,
  SecurityPriceIndex,
} from "./holdings";
import { HoldingsValueData, HoldingValueSummary, HoldingValueHistory } from "../../models/Calculations";
import {
  HoldingSnapshotDictionary,
  SecuritySnapshotDictionary,
  SecurityDictionary,
  InvestmentTransactionDictionary,
} from "../../models/Data";
import { HoldingSnapshot, SecuritySnapshot } from "../../models/Snapshot";
import { Security } from "../../models/miscellaneous";
import { InvestmentTransaction } from "../../models/InvestmentTransaction";

const createSecuritySnapshot = (
  securityId: string,
  closePrice: number,
  date: string,
): SecuritySnapshot => {
  return new SecuritySnapshot({
    snapshot: { snapshot_id: `snap_${securityId}_${date}`, date },
    security: {
      security_id: securityId,
      close_price: closePrice,
      close_price_as_of: date,
    },
  });
};

const createSecurity = (
  securityId: string,
  extra: Partial<{ type: string; is_cash_equivalent: boolean; ticker_symbol: string }> = {},
): Security => {
  return new Security({ security_id: securityId, ...extra });
};

const securityDict = (...securities: Security[]): SecurityDictionary => {
  const dict = new SecurityDictionary();
  for (const sec of securities) dict.set(sec.security_id, sec);
  return dict;
};

const createHoldingSnapshot = (
  accountId: string,
  securityId: string,
  quantity: number,
  institutionPrice: number,
  institutionValue: number,
  costBasis: number | null,
  date: string
): HoldingSnapshot => {
  return new HoldingSnapshot({
    snapshot: { snapshot_id: `holding_${accountId}_${securityId}_${date}`, date },
    holding: {
      account_id: accountId,
      security_id: securityId,
      quantity,
      institution_price: institutionPrice,
      institution_value: institutionValue,
      cost_basis: costBasis,
      holding_id: `${accountId}_${securityId}`,
    },
  });
};

const createInvestmentTransaction = (
  accountId: string,
  securityId: string,
  type: InvestmentTransactionType,
  price: number,
  quantity: number,
  date: string,
  fees: number = 0
): InvestmentTransaction => {
  return new InvestmentTransaction({
    investment_transaction_id: `tx_${accountId}_${securityId}_${date}`,
    account_id: accountId,
    security_id: securityId,
    type,
    subtype:
      type === InvestmentTransactionType.Buy
        ? InvestmentTransactionSubtype.Buy
        : InvestmentTransactionSubtype.Sell,
    price,
    quantity,
    date,
    fees,
    amount: price * quantity,
    name: "Test Transaction",
  });
};

describe("buildSecurityPriceIndex", () => {
  test("should build index from security snapshots", () => {
    const snapshots = new SecuritySnapshotDictionary();
    snapshots.set("snap1", createSecuritySnapshot("sec1", 100, "2026-01-15"));
    snapshots.set("snap2", createSecuritySnapshot("sec1", 110, "2026-02-15"));
    snapshots.set("snap3", createSecuritySnapshot("sec2", 50, "2026-01-20"));

    const index = buildSecurityPriceIndex(snapshots);

    expect(index.get("sec1")?.get("2026-01")).toEqual({ price: 100, sourceDate: "2026-01-15" });
    expect(index.get("sec1")?.get("2026-02")).toEqual({ price: 110, sourceDate: "2026-02-15" });
    expect(index.get("sec2")?.get("2026-01")).toEqual({ price: 50, sourceDate: "2026-01-20" });
  });

  test("keeps the entry with the later sourceDate when the same month has multiple snapshots", () => {
    const snapshots = new SecuritySnapshotDictionary();
    snapshots.set("snap1", createSecuritySnapshot("sec1", 100, "2026-01-10"));
    snapshots.set("snap2", createSecuritySnapshot("sec1", 105, "2026-01-25")); // later in same month
    snapshots.set("snap3", createSecuritySnapshot("sec1", 95, "2026-01-15")); // earlier than snap2

    const index = buildSecurityPriceIndex(snapshots);

    // The Jan-25 entry wins regardless of iteration order over the dictionary.
    expect(index.get("sec1")?.get("2026-01")).toEqual({ price: 105, sourceDate: "2026-01-25" });
  });

  test("should skip snapshots with null close_price", () => {
    const snapshots = new SecuritySnapshotDictionary();
    const snapshot = createSecuritySnapshot("sec1", 100, "2026-01-15");
    snapshot.security.close_price = null;
    snapshots.set("snap1", snapshot);

    const index = buildSecurityPriceIndex(snapshots);

    expect(index.has("sec1")).toBe(false);
  });

  test("should handle empty dictionary", () => {
    const snapshots = new SecuritySnapshotDictionary();
    const index = buildSecurityPriceIndex(snapshots);

    expect(index.size).toBe(0);
  });

  test("buckets by snapshot date, not the security's shared close_price_as_of", () => {
    // In production the server attaches the security's single live
    // `close_price_as_of` to every historical snapshot in the join, so all
    // snapshots of one security share an identical `close_price_as_of` while
    // their `close_price` and snapshot dates differ per month. Bucketing off
    // `close_price_as_of` would collapse the whole series into one month.
    const sharedAsOf = "2026-03-30";
    const snapshots = new SecuritySnapshotDictionary();
    for (const [date, price] of [
      ["2026-01-15", 100],
      ["2026-02-15", 110],
      ["2026-03-15", 120],
    ] as const) {
      const snap = createSecuritySnapshot("sec1", price, date);
      snap.security.close_price_as_of = sharedAsOf;
      snapshots.set(`snap_${date}`, snap);
    }

    const index = buildSecurityPriceIndex(snapshots);

    // Three distinct monthly buckets, each priced and dated by its own snapshot
    // — not one collapsed "2026-03" bucket.
    const sec1 = index.get("sec1");
    expect(sec1?.size).toBe(3);
    expect(sec1?.get("2026-01")).toEqual({ price: 100, sourceDate: "2026-01-15" });
    expect(sec1?.get("2026-02")).toEqual({ price: 110, sourceDate: "2026-02-15" });
    expect(sec1?.get("2026-03")).toEqual({ price: 120, sourceDate: "2026-03-15" });
  });
});

describe("getPriceForHolding", () => {
  const emptyIndex: SecurityPriceIndex = new Map();

  test("on equal source dates the security snapshot wins (tie-breaker)", () => {
    // Both sources report on 2026-01-15; the security snapshot wins on tie.
    const holding = createHoldingSnapshot("acc1", "sec1", 10, 100, 1000, null, "2026-01-15");
    const snapshots = new SecuritySnapshotDictionary();
    snapshots.set("snap1", createSecuritySnapshot("sec1", 95, "2026-01-15"));
    const index = buildSecurityPriceIndex(snapshots);

    const result = getPriceForHolding({
      holding,
      securityPriceIndex: index,
      date: new Date("2026-01-15"),
    });

    expect(result).toEqual({ price: 95, source: "market" });
  });

  test("security wins when its sourceDate is more recent than the holding snapshot", () => {
    // Holding snapshot dated 2026-01-10 (early in month); security snapshot dated 2026-01-25.
    // The security is fresher → security wins regardless of priority order.
    const holding = createHoldingSnapshot("acc1", "sec1", 10, 100, 1000, null, "2026-01-10");
    const snapshots = new SecuritySnapshotDictionary();
    snapshots.set("snap1", createSecuritySnapshot("sec1", 95, "2026-01-25"));
    const index = buildSecurityPriceIndex(snapshots);

    const result = getPriceForHolding({
      holding,
      securityPriceIndex: index,
      date: new Date("2026-01-31"),
    });

    expect(result).toEqual({ price: 95, source: "market" });
  });

  test("institution_price wins when the holding snapshot is more recent than any security snapshot", () => {
    // Holding snapshot 2026-01-28 — broker reported recently. Security snapshot 2026-01-10 — stale.
    // Holding is fresher → institution_price wins.
    const holding = createHoldingSnapshot("acc1", "sec1", 10, 100, 1000, null, "2026-01-28");
    const snapshots = new SecuritySnapshotDictionary();
    snapshots.set("snap1", createSecuritySnapshot("sec1", 95, "2026-01-10"));
    const index = buildSecurityPriceIndex(snapshots);

    const result = getPriceForHolding({
      holding,
      securityPriceIndex: index,
      date: new Date("2026-01-31"),
    });

    expect(result).toEqual({ price: 100, source: "institution" });
  });

  test("walks back to the latest snapshot ≤ view date when current month has no snapshot", () => {
    const holding = createHoldingSnapshot("acc1", "sec1", 10, 0, 1000, null, "2026-04-15");
    const snapshots = new SecuritySnapshotDictionary();
    // Snapshots in Jan and Feb, no Mar/Apr.
    snapshots.set("s1", createSecuritySnapshot("sec1", 90, "2026-01-15"));
    snapshots.set("s2", createSecuritySnapshot("sec1", 105, "2026-02-15"));
    const index = buildSecurityPriceIndex(snapshots);

    const result = getPriceForHolding({
      holding,
      securityPriceIndex: index,
      date: new Date("2026-04-15"),
    });

    // April lookup walks back to February's 105 — the latest ≤ Apr.
    expect(result).toEqual({ price: 105, source: "market" });
  });

  test("does not use a future snapshot when the view date precedes all snapshots", () => {
    const holding = createHoldingSnapshot("acc1", "sec1", 10, 100, 1000, null, "2025-12-15");
    const snapshots = new SecuritySnapshotDictionary();
    // Only a Jan 2026 snapshot — should NOT be used for Dec 2025.
    snapshots.set("s1", createSecuritySnapshot("sec1", 95, "2026-01-15"));
    const index = buildSecurityPriceIndex(snapshots);

    const result = getPriceForHolding({
      holding,
      securityPriceIndex: index,
      date: new Date("2025-12-15"),
    });

    // No snapshot ≤ Dec 2025 → falls back to institution_price.
    expect(result).toEqual({ price: 100, source: "institution" });
  });

  test("falls back to institution_price when no security snapshot exists (Priority 2)", () => {
    const holding = createHoldingSnapshot("acc1", "sec1", 10, 100, 1000, null, "2026-01-15");

    const result = getPriceForHolding({
      holding,
      securityPriceIndex: emptyIndex,
      date: new Date("2026-01-15"),
    });

    expect(result).toEqual({ price: 100, source: "institution" });
  });

  test("infers price from value/quantity when neither market nor institution is available (Priority 3)", () => {
    const holding = createHoldingSnapshot("acc1", "sec1", 10, 0, 1000, null, "2026-01-15");

    const result = getPriceForHolding({
      holding,
      securityPriceIndex: emptyIndex,
      date: new Date("2026-01-15"),
    });

    expect(result).toEqual({ price: 100, source: "inferred" });
  });

  test("returns null when no price can be determined", () => {
    const holding = createHoldingSnapshot("acc1", "sec1", 0, 0, 0, null, "2026-01-15");

    const result = getPriceForHolding({
      holding,
      securityPriceIndex: emptyIndex,
      date: new Date("2026-01-15"),
    });

    expect(result).toBeNull();
  });
});

describe("inferCostBasis", () => {
  test("should calculate cost basis from buy transactions", () => {
    const transactions = new InvestmentTransactionDictionary();
    transactions.set(
      "tx1",
      createInvestmentTransaction("acc1", "sec1", InvestmentTransactionType.Buy, 100, 5, "2026-01-10")
    );
    transactions.set(
      "tx2",
      createInvestmentTransaction("acc1", "sec1", InvestmentTransactionType.Buy, 110, 3, "2026-01-15")
    );

    const result = inferCostBasis({
      accountId: "acc1",
      securityId: "sec1",
      investmentTransactions: transactions,
      asOfDate: new Date("2026-01-20"),
    });

    expect(result).not.toBeNull();
    expect(result!.costBasis).toBe(500 + 330); // 830
    expect(result!.totalQuantity).toBe(8);
    expect(result!.inferred).toBe(true);
  });

  test("should include fees in cost basis", () => {
    const transactions = new InvestmentTransactionDictionary();
    transactions.set(
      "tx1",
      createInvestmentTransaction(
        "acc1",
        "sec1",
        InvestmentTransactionType.Buy,
        100,
        5,
        "2026-01-10",
        10
      )
    );

    const result = inferCostBasis({
      accountId: "acc1",
      securityId: "sec1",
      investmentTransactions: transactions,
      asOfDate: new Date("2026-01-20"),
    });

    expect(result!.costBasis).toBe(500 + 10); // 510
  });

  test("should handle sells using average cost method", () => {
    const transactions = new InvestmentTransactionDictionary();
    // Buy 10 @ $100 = $1000 total cost
    transactions.set(
      "tx1",
      createInvestmentTransaction("acc1", "sec1", InvestmentTransactionType.Buy, 100, 10, "2026-01-10")
    );
    // Sell 4 @ avg cost $100 = $400 removed.
    // Plaid encodes sell quantities as NEGATIVE — use the real shape (-4).
    transactions.set(
      "tx2",
      createInvestmentTransaction("acc1", "sec1", InvestmentTransactionType.Sell, 120, -4, "2026-01-15")
    );

    const result = inferCostBasis({
      accountId: "acc1",
      securityId: "sec1",
      investmentTransactions: transactions,
      asOfDate: new Date("2026-01-20"),
    });

    expect(result!.totalQuantity).toBe(6);
    expect(result!.costBasis).toBe(600); // $1000 - $400 = $600
  });

  test("should reduce (not inflate) basis when a sell uses Plaid's negative quantity", () => {
    // Regression for #459: a negative sell quantity must remove shares + basis,
    // not add them. Pre-fix this returned { totalQuantity: 14, costBasis: 1400 }.
    const transactions = new InvestmentTransactionDictionary();
    // Buy 10 @ $100 = $1000
    transactions.set(
      "tx1",
      createInvestmentTransaction("acc1", "sec1", InvestmentTransactionType.Buy, 100, 10, "2026-01-10")
    );
    // Sell 4 shares — Plaid encodes quantity = -4
    transactions.set(
      "tx2",
      createInvestmentTransaction("acc1", "sec1", InvestmentTransactionType.Sell, 130, -4, "2026-01-15")
    );

    const result = inferCostBasis({
      accountId: "acc1",
      securityId: "sec1",
      investmentTransactions: transactions,
      asOfDate: new Date("2026-01-20"),
    });

    expect(result!.totalQuantity).toBe(6);
    expect(result!.costBasis).toBe(600);
  });

  test("should filter by date", () => {
    const transactions = new InvestmentTransactionDictionary();
    transactions.set(
      "tx1",
      createInvestmentTransaction("acc1", "sec1", InvestmentTransactionType.Buy, 100, 5, "2026-01-10")
    );
    transactions.set(
      "tx2",
      createInvestmentTransaction("acc1", "sec1", InvestmentTransactionType.Buy, 110, 5, "2026-02-10")
    );

    const result = inferCostBasis({
      accountId: "acc1",
      securityId: "sec1",
      investmentTransactions: transactions,
      asOfDate: new Date("2026-01-20"),
    });

    // Should only include first transaction
    expect(result!.costBasis).toBe(500);
    expect(result!.totalQuantity).toBe(5);
  });

  test("should filter by account and security", () => {
    const transactions = new InvestmentTransactionDictionary();
    transactions.set(
      "tx1",
      createInvestmentTransaction("acc1", "sec1", InvestmentTransactionType.Buy, 100, 5, "2026-01-10")
    );
    transactions.set(
      "tx2",
      createInvestmentTransaction("acc2", "sec1", InvestmentTransactionType.Buy, 100, 5, "2026-01-10")
    );
    transactions.set(
      "tx3",
      createInvestmentTransaction("acc1", "sec2", InvestmentTransactionType.Buy, 100, 5, "2026-01-10")
    );

    const result = inferCostBasis({
      accountId: "acc1",
      securityId: "sec1",
      investmentTransactions: transactions,
      asOfDate: new Date("2026-01-20"),
    });

    expect(result!.costBasis).toBe(500);
    expect(result!.totalQuantity).toBe(5);
  });

  test("should return null when no transactions found", () => {
    const transactions = new InvestmentTransactionDictionary();

    const result = inferCostBasis({
      accountId: "acc1",
      securityId: "sec1",
      investmentTransactions: transactions,
      asOfDate: new Date("2026-01-20"),
    });

    expect(result).toBeNull();
  });
});

describe("getHoldingsValueData", () => {
  test("should build holdings value data from snapshots", () => {
    const holdingSnapshots = new HoldingSnapshotDictionary();
    holdingSnapshots.set(
      "h1",
      createHoldingSnapshot("acc1", "sec1", 10, 100, 1000, 800, "2026-01-15")
    );

    const securitySnapshots = new SecuritySnapshotDictionary();
    const investmentTransactions = new InvestmentTransactionDictionary();

    const result = getHoldingsValueData({
      holdingSnapshots,
      securitySnapshots,
      securities: new SecurityDictionary(),
      investmentTransactions,
    });

    expect(result.size).toBe(1);
    const value = result.getHoldingValue("acc1_sec1", new Date("2026-01-15"));
    expect(value).toBe(1000); // 10 * 100
  });

  test("should infer cost basis when missing", () => {
    const holdingSnapshots = new HoldingSnapshotDictionary();
    holdingSnapshots.set(
      "h1",
      createHoldingSnapshot("acc1", "sec1", 10, 100, 1000, 0, "2026-01-20")
    );

    const securitySnapshots = new SecuritySnapshotDictionary();
    const investmentTransactions = new InvestmentTransactionDictionary();
    investmentTransactions.set(
      "tx1",
      createInvestmentTransaction("acc1", "sec1", InvestmentTransactionType.Buy, 90, 10, "2026-01-10")
    );

    const result = getHoldingsValueData({
      holdingSnapshots,
      securitySnapshots,
      securities: new SecurityDictionary(),
      investmentTransactions,
    });

    const costBasis = result.getHoldingCostBasis("acc1_sec1", new Date("2026-01-20"));
    expect(costBasis).toBe(900); // 90 * 10
  });

  test("classifies a holding with institution_price=1 as cash (yields 0% gain)", () => {
    // FE cash detector is per-holding: institution_price === 1 is the
    // canonical signal because brokers always quote 1.0 for cash. Cash
    // rows report `cost_basis === value` so unrealizedGain === 0 and
    // returnPercent === 0 — the logically-correct readout for a position
    // that doesn't appreciate against itself. The `inferCostBasis`
    // transaction-replay path is skipped — Plaid encodes sweep deposits
    // as `type='buy'` with `price=1`, which would otherwise pile up a
    // phantom basis (= deposit total) with a phantom G/L.
    const holdingSnapshots = new HoldingSnapshotDictionary();
    holdingSnapshots.set(
      "h-cash",
      createHoldingSnapshot("acc1", "sec-cash", 1000, 1, 1000, null, "2026-01-15"),
    );

    const investmentTransactions = new InvestmentTransactionDictionary();
    investmentTransactions.set(
      "tx-deposit",
      createInvestmentTransaction(
        "acc1",
        "sec-cash",
        InvestmentTransactionType.Buy,
        1,
        1000,
        "2026-01-10",
      ),
    );

    const result = getHoldingsValueData({
      holdingSnapshots,
      securitySnapshots: new SecuritySnapshotDictionary(),
      securities: new SecurityDictionary(),
      investmentTransactions,
    });

    const summary = result.getHistory("acc1_sec-cash").get(new Date("2026-01-15"));
    expect(summary).toBeDefined();
    expect(summary!.isCash).toBe(true);
    expect(summary!.value).toBe(1000);
    expect(summary!.costBasis).toBe(1000);
    expect(summary!.unrealizedGain).toBe(0);
    expect(summary!.returnPercent).toBe(0);
  });

  test("classifies cash uniformly regardless of cost_basis (null / 0 / value)", () => {
    // The detector keys off `institution_price === 1` only — `cost_basis`
    // does not participate. A cash row whose `cost_basis` lands on the
    // wire as null (BE-inferred row), 0 (DB-NULL collapsed via `?? 0` in
    // `SnapshotModel.toHoldingSnapshot`), or the full balance (Plaid
    // reporting the same dollar amount) all normalize to
    // `cost_basis === value` and 0% gain.
    const holdingSnapshots = new HoldingSnapshotDictionary();
    holdingSnapshots.set("c-null", createHoldingSnapshot("acc1", "sec-a", 1000, 1, 1000, null, "2026-01-15"));
    holdingSnapshots.set("c-zero", createHoldingSnapshot("acc1", "sec-b", 1000, 1, 1000, 0, "2026-01-15"));
    holdingSnapshots.set("c-full", createHoldingSnapshot("acc1", "sec-c", 1000, 1, 1000, 1000, "2026-01-15"));

    const result = getHoldingsValueData({
      holdingSnapshots,
      securitySnapshots: new SecuritySnapshotDictionary(),
      securities: new SecurityDictionary(),
      investmentTransactions: new InvestmentTransactionDictionary(),
    });

    for (const sec of ["sec-a", "sec-b", "sec-c"]) {
      const summary = result.getHistory(`acc1_${sec}`).get(new Date("2026-01-15"));
      expect(summary!.isCash).toBe(true);
      expect(summary!.costBasis).toBe(1000);
      expect(summary!.unrealizedGain).toBe(0);
      expect(summary!.returnPercent).toBe(0);
    }
  });

  test("a real $1 equity with a cost_basis is treated as cash by the holding-side detector", () => {
    // `institution_price === 1` matches real $1 equities too. Those
    // holdings render under the cash branch as `cost_basis === value`
    // (here, value=$100 → basis=$100 → 0% gain). Trade-off pinned so
    // a future tightening of the detector flips this loudly.
    const holdingSnapshots = new HoldingSnapshotDictionary();
    holdingSnapshots.set(
      "h-penny",
      createHoldingSnapshot("acc1", "sec-penny", 100, 1, 100, 90, "2026-01-15"),
    );

    const result = getHoldingsValueData({
      holdingSnapshots,
      securitySnapshots: new SecuritySnapshotDictionary(),
      securities: new SecurityDictionary(),
      investmentTransactions: new InvestmentTransactionDictionary(),
    });

    const summary = result.getHistory("acc1_sec-penny").get(new Date("2026-01-15"));
    expect(summary!.isCash).toBe(true);
    expect(summary!.costBasis).toBe(100);
    expect(summary!.unrealizedGain).toBe(0);
    expect(summary!.returnPercent).toBe(0);
  });

  test("classifies cash via the security-side branch even when institution_price drifts off 1.0", () => {
    // Two-channel detection — security-side OR holding-side. This test
    // exercises the security-side branch: a money-market fund whose broker
    // quote landed at 0.9999 (FX precision / stale quote) still gets
    // classified as cash because its security record says `type: "cash"`.
    // Source of truth = the `securities` dict, not the snapshot blob.
    const holdingSnapshots = new HoldingSnapshotDictionary();
    holdingSnapshots.set(
      "h-mmkt",
      // institution_price=0.9999 (not 1.0) — holding-side branch would miss
      createHoldingSnapshot("acc1", "sec-mmkt", 1000, 0.9999, 999.9, 999.9, "2026-01-15"),
    );
    const securitySnapshots = new SecuritySnapshotDictionary();
    securitySnapshots.set("snap-mmkt", createSecuritySnapshot("sec-mmkt", 1, "2026-01-15"));

    const result = getHoldingsValueData({
      holdingSnapshots,
      securitySnapshots,
      securities: securityDict(createSecurity("sec-mmkt", { type: "cash" })),
      investmentTransactions: new InvestmentTransactionDictionary(),
    });

    const summary = result.getHistory("acc1_sec-mmkt").get(new Date("2026-01-15"));
    expect(summary!.isCash).toBe(true);
    expect(summary!.returnPercent).toBe(0);
  });

  test("classifies cash via the security-side branch on is_cash_equivalent or CUR:* ticker", () => {
    const holdingSnapshots = new HoldingSnapshotDictionary();
    holdingSnapshots.set(
      "h-equiv",
      createHoldingSnapshot("acc1", "sec-equiv", 500, 0.98, 490, 490, "2026-01-15"),
    );
    holdingSnapshots.set(
      "h-eur",
      createHoldingSnapshot("acc1", "sec-eur", 300, 0.92, 276, 276, "2026-01-15"),
    );

    const securitySnapshots = new SecuritySnapshotDictionary();
    securitySnapshots.set("snap-equiv", createSecuritySnapshot("sec-equiv", 1, "2026-01-15"));
    securitySnapshots.set("snap-eur", createSecuritySnapshot("sec-eur", 1, "2026-01-15"));

    const result = getHoldingsValueData({
      holdingSnapshots,
      securitySnapshots,
      securities: securityDict(
        createSecurity("sec-equiv", { is_cash_equivalent: true }),
        createSecurity("sec-eur", { ticker_symbol: "CUR:EUR" }),
      ),
      investmentTransactions: new InvestmentTransactionDictionary(),
    });

    const equiv = result.getHistory("acc1_sec-equiv").get(new Date("2026-01-15"));
    expect(equiv!.isCash).toBe(true);
    expect(equiv!.returnPercent).toBe(0);

    const eur = result.getHistory("acc1_sec-eur").get(new Date("2026-01-15"));
    expect(eur!.isCash).toBe(true);
    expect(eur!.returnPercent).toBe(0);
  });

  test("does NOT treat a non-cash holding (institution_price > 1) as cash even with null cost_basis", () => {
    // Equities with no broker-provided cost_basis still get inferCostBasis,
    // which is the existing "infer from transactions" path. The cash skip
    // requires BOTH institution_price === 1 AND cost_basis === null.
    const holdingSnapshots = new HoldingSnapshotDictionary();
    holdingSnapshots.set(
      "h-equity",
      createHoldingSnapshot("acc1", "sec-equity", 10, 100, 1000, null, "2026-01-15"),
    );

    const investmentTransactions = new InvestmentTransactionDictionary();
    investmentTransactions.set(
      "tx-buy",
      createInvestmentTransaction(
        "acc1",
        "sec-equity",
        InvestmentTransactionType.Buy,
        90,
        10,
        "2026-01-10",
      ),
    );

    const result = getHoldingsValueData({
      holdingSnapshots,
      securitySnapshots: new SecuritySnapshotDictionary(),
      securities: new SecurityDictionary(),
      investmentTransactions,
    });

    const summary = result.getHistory("acc1_sec-equity").get(new Date("2026-01-15"));
    // institution_price=100 → not cash → inferCostBasis runs → basis = 90×10 = 900
    expect(summary!.costBasis).toBe(900);
    expect(summary!.costBasisInferred).toBe(true);
    expect(summary!.unrealizedGain).toBe(100); // 1000 - 900
  });

  test("should preserve provided cost basis", () => {
    const holdingSnapshots = new HoldingSnapshotDictionary();
    holdingSnapshots.set(
      "h1",
      createHoldingSnapshot("acc1", "sec1", 10, 100, 1000, 850, "2026-01-15")
    );

    const securitySnapshots = new SecuritySnapshotDictionary();
    const investmentTransactions = new InvestmentTransactionDictionary();

    const result = getHoldingsValueData({
      holdingSnapshots,
      securitySnapshots,
      securities: new SecurityDictionary(),
      investmentTransactions,
    });

    const costBasis = result.getHoldingCostBasis("acc1_sec1", new Date("2026-01-15"));
    expect(costBasis).toBe(850); // Use provided, not inferred
  });

  test("should handle multiple holdings", () => {
    const holdingSnapshots = new HoldingSnapshotDictionary();
    holdingSnapshots.set(
      "h1",
      createHoldingSnapshot("acc1", "sec1", 10, 100, 1000, null, "2026-01-15")
    );
    holdingSnapshots.set(
      "h2",
      createHoldingSnapshot("acc1", "sec2", 5, 200, 1000, null, "2026-01-15")
    );
    holdingSnapshots.set(
      "h3",
      createHoldingSnapshot("acc2", "sec1", 20, 100, 2000, null, "2026-01-15")
    );

    const securitySnapshots = new SecuritySnapshotDictionary();
    const investmentTransactions = new InvestmentTransactionDictionary();

    const result = getHoldingsValueData({
      holdingSnapshots,
      securitySnapshots,
      securities: new SecurityDictionary(),
      investmentTransactions,
    });

    expect(result.size).toBe(3);
    expect(result.getAccountTotalValue("acc1", new Date("2026-01-15"))).toBe(2000); // 1000 + 1000
    expect(result.getAccountTotalValue("acc2", new Date("2026-01-15"))).toBe(2000);
  });

  test("should use most recent snapshot for each month", () => {
    const holdingSnapshots = new HoldingSnapshotDictionary();
    holdingSnapshots.set(
      "h1",
      createHoldingSnapshot("acc1", "sec1", 10, 100, 1000, null, "2026-01-10")
    );
    holdingSnapshots.set(
      "h2",
      createHoldingSnapshot("acc1", "sec1", 15, 110, 1650, null, "2026-01-20")
    );

    const securitySnapshots = new SecuritySnapshotDictionary();
    const investmentTransactions = new InvestmentTransactionDictionary();

    const result = getHoldingsValueData({
      holdingSnapshots,
      securitySnapshots,
      securities: new SecurityDictionary(),
      investmentTransactions,
    });

    // Should use the Jan 20 snapshot (15 * 110 = 1650)
    const value = result.getHoldingValue("acc1_sec1", new Date("2026-01-15"));
    expect(value).toBe(1650);
  });
});

// ---------------------------------------------------------------------------
// getEarningsForPeriod tests
// ---------------------------------------------------------------------------

describe("getEarningsForPeriod", () => {
  /**
   * Build HoldingsValueData directly (bypasses Dictionary.set constraints
   * in server test context) so we can test getEarningsForPeriod in isolation.
   */
  const jan = new Date("2026-01-15");
  const feb = new Date("2026-02-15");

  const buildData = (): HoldingsValueData => {
    const data = new HoldingsValueData();
    const history = new HoldingValueHistory();
    history.set(
      jan,
      new HoldingValueSummary({
        value: 1000,
        costBasis: 800,
        quantity: 10,
        price: 100,
        security_id: "sec1",
        account_id: "acc1",
        costBasisInferred: false,
      })
    );
    history.set(
      feb,
      new HoldingValueSummary({
        value: 1200,
        costBasis: 800,
        quantity: 10,
        price: 120,
        security_id: "sec1",
        account_id: "acc1",
        costBasisInferred: false,
      })
    );
    data.set("acc1_sec1", history);
    return data;
  };

  test("calculates periodReturn and unrealizedGain for a single holding", () => {
    const data = buildData();
    const result = getEarningsForPeriod(data, jan, feb);

    expect(result.holdings).toHaveLength(1);
    const h = result.holdings[0];

    expect(h.holding_id).toBe("acc1_sec1");
    expect(h.security_id).toBe("sec1");
    expect(h.account_id).toBe("acc1");
    expect(h.startValue).toBe(1000);
    expect(h.endValue).toBe(1200);
    expect(h.costBasis).toBe(800);
    expect(h.unrealizedGain).toBe(400);  // 1200 - 800
    expect(h.periodReturn).toBe(200);    // 1200 - 1000
    expect(h.costBasisInferred).toBe(false);
  });

  test("aggregates totals correctly", () => {
    const data = buildData();
    const result = getEarningsForPeriod(data, jan, feb);

    expect(result.totalStartValue).toBe(1000);
    expect(result.totalEndValue).toBe(1200);
    expect(result.totalCostBasis).toBe(800);
    expect(result.totalUnrealizedGain).toBe(400);
    expect(result.totalPeriodReturn).toBe(200);
  });

  test("uses 0 for startValue when no data at start date", () => {
    const data = buildData();
    const dec = new Date("2025-12-15");
    // Dec has no snapshot; Jan does → startValue=0, endValue=1000
    const result = getEarningsForPeriod(data, dec, jan);

    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0].startValue).toBe(0);
    expect(result.holdings[0].endValue).toBe(1000);
    expect(result.totalPeriodReturn).toBe(1000);
  });

  test("returns null totals when any holding lacks cost basis", () => {
    const data = new HoldingsValueData();
    const history = new HoldingValueHistory();
    history.set(
      jan,
      new HoldingValueSummary({
        value: 250,
        costBasis: null,
        quantity: 5,
        price: 50,
        security_id: "sec2",
        account_id: "acc2",
        costBasisInferred: false,
      })
    );
    history.set(
      feb,
      new HoldingValueSummary({
        value: 300,
        costBasis: null,
        quantity: 5,
        price: 60,
        security_id: "sec2",
        account_id: "acc2",
        costBasisInferred: false,
      })
    );
    data.set("acc2_sec2", history);

    const result = getEarningsForPeriod(data, jan, feb);
    expect(result.holdings[0].costBasis).toBeNull();
    expect(result.holdings[0].unrealizedGain).toBeNull();
    expect(result.totalCostBasis).toBeNull();
    expect(result.totalUnrealizedGain).toBeNull();
    expect(result.totalPeriodReturn).toBe(50); // 300 - 250
  });

  test("returns empty result for empty holdingsValueData", () => {
    const data = new HoldingsValueData();
    const result = getEarningsForPeriod(data, jan, feb);
    expect(result.holdings).toHaveLength(0);
    expect(result.totalStartValue).toBe(0);
    expect(result.totalEndValue).toBe(0);
    expect(result.totalCostBasis).toBe(0);
    expect(result.totalUnrealizedGain).toBe(0);
    expect(result.totalPeriodReturn).toBe(0);
  });

  test("sums across multiple holdings", () => {
    const data = buildData();
    // Add a second holding
    const history2 = new HoldingValueHistory();
    history2.set(
      jan,
      new HoldingValueSummary({
        value: 500,
        costBasis: 400,
        quantity: 5,
        price: 100,
        security_id: "sec3",
        account_id: "acc1",
        costBasisInferred: false,
      })
    );
    history2.set(
      feb,
      new HoldingValueSummary({
        value: 600,
        costBasis: 400,
        quantity: 5,
        price: 120,
        security_id: "sec3",
        account_id: "acc1",
        costBasisInferred: false,
      })
    );
    data.set("acc1_sec3", history2);

    const result = getEarningsForPeriod(data, jan, feb);
    expect(result.holdings).toHaveLength(2);
    expect(result.totalStartValue).toBe(1500);  // 1000 + 500
    expect(result.totalEndValue).toBe(1800);    // 1200 + 600
    expect(result.totalCostBasis).toBe(1200);   // 800 + 400
    expect(result.totalUnrealizedGain).toBe(600); // 400 + 200
    expect(result.totalPeriodReturn).toBe(300);   // 200 + 100
  });
});