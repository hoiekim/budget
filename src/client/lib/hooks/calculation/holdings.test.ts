// Run with: bun test --preload ./test-preload.ts holdings.test.ts
import { describe, test, expect } from "bun:test";
import { InvestmentTransactionType, InvestmentTransactionSubtype } from "plaid";

import {
  buildSecurityPriceIndex,
  getPriceForHolding,
  inferCostBasis,
  getHoldingsValueData,
  SecurityPriceIndex,
} from "./holdings";
import {
  HoldingSnapshotDictionary,
  SecuritySnapshotDictionary,
  InvestmentTransactionDictionary,
} from "../../models/Data";
import { HoldingSnapshot, SecuritySnapshot } from "../../models/Snapshot";
import { InvestmentTransaction } from "../../models/InvestmentTransaction";

const createSecuritySnapshot = (
  securityId: string,
  closePrice: number,
  date: string
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

    expect(index.get("sec1")?.get("2026-01")).toBe(100);
    expect(index.get("sec1")?.get("2026-02")).toBe(110);
    expect(index.get("sec2")?.get("2026-01")).toBe(50);
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
});

describe("getPriceForHolding", () => {
  const emptyIndex: SecurityPriceIndex = new Map();

  test("should use institution_price when available (Priority 1)", () => {
    const holding = createHoldingSnapshot("acc1", "sec1", 10, 100, 1000, null, "2026-01-15");

    const result = getPriceForHolding({
      holding,
      securityPriceIndex: emptyIndex,
      date: new Date("2026-01-15"),
    });

    expect(result).toEqual({ price: 100, source: "institution" });
  });

  test("should use market price when institution_price is zero (Priority 2)", () => {
    const holding = createHoldingSnapshot("acc1", "sec1", 10, 0, 1000, null, "2026-01-15");
    
    // Build index manually since Dictionary.set is what we're testing around
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

  test("should infer price from value/quantity when others unavailable (Priority 3)", () => {
    const holding = createHoldingSnapshot("acc1", "sec1", 10, 0, 1000, null, "2026-01-15");

    const result = getPriceForHolding({
      holding,
      securityPriceIndex: emptyIndex,
      date: new Date("2026-01-15"),
    });

    expect(result).toEqual({ price: 100, source: "inferred" });
  });

  test("should return null when no price can be determined", () => {
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
    // Sell 4 @ avg cost $100 = $400 removed
    transactions.set(
      "tx2",
      createInvestmentTransaction("acc1", "sec1", InvestmentTransactionType.Sell, 120, 4, "2026-01-15")
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
      investmentTransactions,
    });

    const costBasis = result.getHoldingCostBasis("acc1_sec1", new Date("2026-01-20"));
    expect(costBasis).toBe(900); // 90 * 10
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
      investmentTransactions,
    });

    // Should use the Jan 20 snapshot (15 * 110 = 1650)
    const value = result.getHoldingValue("acc1_sec1", new Date("2026-01-15"));
    expect(value).toBe(1650);
  });
});
