import { getYearMonthString, LocalDate } from "common";
import { InvestmentTransactionType } from "plaid";
import { HoldingValueSummary, HoldingsValueData } from "../../models/Calcuations";
import {
  HoldingSnapshotDictionary,
  InvestmentTransactionDictionary,
  SecuritySnapshotDictionary,
} from "../../models/Data";
import { HoldingSnapshot } from "../../models/Snapshot";
import { InvestmentTransaction } from "../../models/InvestmentTransaction";

/**
 * Index structure: security_id -> yearMonth -> close_price
 */
export type SecurityPriceIndex = Map<string, Map<string, number>>;

/**
 * Builds an index of security prices by security_id and yearMonth.
 * Uses the most recent snapshot for each month if multiple exist.
 */
export const buildSecurityPriceIndex = (
  securitySnapshots: SecuritySnapshotDictionary
): SecurityPriceIndex => {
  const index: SecurityPriceIndex = new Map();

  securitySnapshots.forEach((snapshot) => {
    const { security } = snapshot;
    const { security_id, close_price, close_price_as_of } = security;

    if (!security_id || close_price === null || close_price === undefined) return;

    const dateStr = close_price_as_of || snapshot.snapshot.date;
    if (!dateStr) return;

    const date = new LocalDate(dateStr);
    const yearMonth = getYearMonthString(date);

    if (!index.has(security_id)) {
      index.set(security_id, new Map());
    }

    const securityIndex = index.get(security_id)!;

    // Keep the most recent price for each month
    // (later entries overwrite earlier ones, which works for snapshots in order)
    securityIndex.set(yearMonth, close_price);
  });

  return index;
};

interface PriceForHoldingParams {
  holding: HoldingSnapshot;
  securityPriceIndex: SecurityPriceIndex;
  date: Date;
}

interface PriceResult {
  price: number;
  source: "institution" | "market" | "inferred";
}

/**
 * Gets the price for a holding using the 3-tier fallback strategy:
 * 1. institution_price from holding (brokerage-reported)
 * 2. close_price from security snapshot (market data)
 * 3. Infer from institution_value / quantity
 */
export const getPriceForHolding = ({
  holding,
  securityPriceIndex,
  date,
}: PriceForHoldingParams): PriceResult | null => {
  const { holding: h } = holding;
  const { security_id, institution_price, institution_value, quantity } = h;

  // Priority 1: institution_price from holding (brokerage-reported)
  if (institution_price !== null && institution_price !== undefined && institution_price > 0) {
    return { price: institution_price, source: "institution" };
  }

  // Priority 2: close_price from security snapshot (market data)
  if (security_id) {
    const securityIndex = securityPriceIndex.get(security_id);
    if (securityIndex) {
      const yearMonth = getYearMonthString(date);
      const marketPrice = securityIndex.get(yearMonth);
      if (marketPrice !== undefined && marketPrice > 0) {
        return { price: marketPrice, source: "market" };
      }
    }
  }

  // Priority 3: Infer from institution_value / quantity
  if (
    quantity !== null &&
    quantity !== undefined &&
    quantity !== 0 &&
    institution_value !== null &&
    institution_value !== undefined
  ) {
    const inferredPrice = institution_value / quantity;
    if (inferredPrice > 0) {
      return { price: inferredPrice, source: "inferred" };
    }
  }

  return null;
};

interface CostBasisParams {
  accountId: string;
  securityId: string;
  investmentTransactions: InvestmentTransactionDictionary;
  asOfDate: Date;
}

interface CostBasisResult {
  costBasis: number;
  totalQuantity: number;
  inferred: boolean;
}

/**
 * Infers cost basis from investment transactions using average cost method.
 * Only processes BUY transactions up to the specified date.
 */
export const inferCostBasis = ({
  accountId,
  securityId,
  investmentTransactions,
  asOfDate,
}: CostBasisParams): CostBasisResult | null => {
  let totalCost = 0;
  let totalQuantity = 0;

  const transactions: InvestmentTransaction[] = [];

  investmentTransactions.forEach((t) => {
    if (t.account_id !== accountId) return;
    if (t.security_id !== securityId) return;

    const txDate = new LocalDate(t.date);
    if (txDate > asOfDate) return;

    transactions.push(t);
  });

  // Sort by date ascending
  transactions.sort((a, b) => new LocalDate(a.date).getTime() - new LocalDate(b.date).getTime());

  for (const t of transactions) {
    const { type, price, quantity, fees } = t;

    if (type === InvestmentTransactionType.Buy) {
      // BUY: add to cost basis
      const cost = price * quantity + (fees || 0);
      totalCost += cost;
      totalQuantity += quantity;
    } else if (type === InvestmentTransactionType.Sell) {
      // SELL: reduce quantity using average cost
      // Average cost per share = totalCost / totalQuantity
      if (totalQuantity > 0) {
        const avgCost = totalCost / totalQuantity;
        const soldCost = avgCost * quantity;
        totalCost -= soldCost;
        totalQuantity -= quantity;

        // Prevent negative from rounding errors
        if (totalQuantity < 0) totalQuantity = 0;
        if (totalCost < 0) totalCost = 0;
      }
    }
    // Ignore other transaction types (dividends, transfers, etc.)
  }

  if (totalQuantity <= 0) return null;

  return {
    costBasis: totalCost,
    totalQuantity,
    inferred: true,
  };
};

interface GetHoldingsValueDataParams {
  holdingSnapshots: HoldingSnapshotDictionary;
  securitySnapshots: SecuritySnapshotDictionary;
  investmentTransactions: InvestmentTransactionDictionary;
}

/**
 * Main calculation function that builds HoldingsValueData from snapshots and transactions.
 * Implements price fallback and cost basis inference as specified in the design doc.
 */
export const getHoldingsValueData = ({
  holdingSnapshots,
  securitySnapshots,
  investmentTransactions,
}: GetHoldingsValueDataParams): HoldingsValueData => {
  const holdingsValueData = new HoldingsValueData();
  const securityPriceIndex = buildSecurityPriceIndex(securitySnapshots);

  // Group holding snapshots by holdingId (account_id + security_id) and yearMonth
  const holdingsByIdAndMonth = new Map<string, Map<string, HoldingSnapshot>>();

  holdingSnapshots.forEach((snapshot) => {
    const { holding } = snapshot;
    const { account_id, security_id } = holding;
    const holdingId = `${account_id}_${security_id}`;

    const snapshotDate = new LocalDate(snapshot.snapshot.date);
    const yearMonth = getYearMonthString(snapshotDate);

    if (!holdingsByIdAndMonth.has(holdingId)) {
      holdingsByIdAndMonth.set(holdingId, new Map());
    }

    const monthMap = holdingsByIdAndMonth.get(holdingId)!;

    // Keep the most recent snapshot for each month
    const existing = monthMap.get(yearMonth);
    if (!existing || snapshot.snapshot.date > existing.snapshot.date) {
      monthMap.set(yearMonth, snapshot);
    }
  });

  // Process each holding's monthly snapshots
  holdingsByIdAndMonth.forEach((monthMap, holdingId) => {
    monthMap.forEach((snapshot, yearMonth) => {
      const { holding } = snapshot;
      const { account_id, security_id, quantity, cost_basis } = holding;

      const date = new LocalDate(`${yearMonth}-15`);

      // Get price using fallback strategy
      const priceResult = getPriceForHolding({
        holding: snapshot,
        securityPriceIndex,
        date,
      });

      if (!priceResult) return;

      const { price } = priceResult;
      const value = price * quantity;

      // Determine cost basis
      let finalCostBasis: number | null = cost_basis;
      let costBasisInferred = false;

      // Infer cost basis if missing or zero with quantity
      if ((cost_basis === null || cost_basis === 0) && quantity !== 0) {
        const inferred = inferCostBasis({
          accountId: account_id,
          securityId: security_id,
          investmentTransactions,
          asOfDate: date,
        });

        if (inferred && inferred.costBasis > 0) {
          finalCostBasis = inferred.costBasis;
          costBasisInferred = true;
        }
      }

      const summary = new HoldingValueSummary({
        value,
        costBasis: finalCostBasis,
        quantity,
        price,
        security_id,
        account_id,
        costBasisInferred,
      });

      holdingsValueData.set(holdingId, date, summary);
    });
  });

  return holdingsValueData;
};

// Note: React hook (useHoldingsValueData) is provided separately in the client barrel
// to avoid bundling React dependencies in pure calculation functions.
