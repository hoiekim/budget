import { getYearMonthString, LocalDate } from "common";
import { InvestmentTransactionType } from "plaid";
import { HoldingValueSummary, HoldingsValueData } from "../../models/Calculations";
import {
  HoldingSnapshotDictionary,
  InvestmentTransactionDictionary,
  SecurityDictionary,
  SecuritySnapshotDictionary,
} from "../../models/Data";
import { HoldingSnapshot } from "../../models/Snapshot";
import { InvestmentTransaction } from "../../models/InvestmentTransaction";

/**
 * One entry in the price index. `sourceDate` is the snapshot's own recording
 * date — i.e. when that month's `close_price` was captured. It's needed
 * downstream so we can compare security-snapshot freshness against the holding
 * snapshot's own date and pick whichever's more recent.
 *
 * We deliberately do NOT use the security's `close_price_as_of`: that field is
 * a single per-security constant (the as-of date of the security's *latest*
 * price) that the server attaches to every historical snapshot in the join.
 * Keying off it collapses a security's entire price history into one month
 * bucket and breaks the per-month tie-break (every sourceDate is identical).
 */
export interface PriceIndexEntry {
  price: number;
  sourceDate: string; // YYYY-MM-DD
}

/**
 * Index structure: security_id -> yearMonth -> { price, sourceDate }
 */
export type SecurityPriceIndex = Map<string, Map<string, PriceIndexEntry>>;

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
    const { security_id, close_price } = security;

    if (!security_id || close_price === null || close_price === undefined) return;

    // Bucket by the snapshot's own date: that's when this `close_price` was
    // recorded. (Not `close_price_as_of` — see PriceIndexEntry doc above.)
    const dateStr = snapshot.snapshot.date;
    if (!dateStr) return;

    const date = new LocalDate(dateStr);
    const yearMonth = getYearMonthString(date);

    if (!index.has(security_id)) {
      index.set(security_id, new Map());
    }

    const securityIndex = index.get(security_id)!;

    // Keep the most recent (by sourceDate) entry per month. Iteration order
    // isn't guaranteed, so compare instead of last-write-wins.
    const existing = securityIndex.get(yearMonth);
    if (!existing || dateStr > existing.sourceDate) {
      securityIndex.set(yearMonth, { price: close_price, sourceDate: dateStr });
    }
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
 * Walks back through a security's price index to find the most recent entry
 * whose `yearMonth` is on or before `targetYearMonth`. Returns undefined when
 * the security has no entry at or before that month.
 *
 * yearMonth keys are `YYYY-MM`, which sort correctly as plain strings.
 */
const findLatestEntryLessThanOrEqual = (
  securityIndex: Map<string, PriceIndexEntry>,
  targetYearMonth: string,
): PriceIndexEntry | undefined => {
  let latestYm: string | undefined;
  let latestEntry: PriceIndexEntry | undefined;
  for (const [ym, entry] of securityIndex) {
    if (ym <= targetYearMonth && (latestYm === undefined || ym > latestYm)) {
      latestYm = ym;
      latestEntry = entry;
    }
  }
  return latestEntry;
};

/**
 * Gets the price for a holding. Security and holding snapshots are
 * compared by their source dates rather than ordered by a fixed-priority
 * list. Whichever was recorded later wins; ties go to the security
 * snapshot. This matters because security snapshots can be filled by
 * polygon between Plaid syncs, so the broker's `institution_price` can
 * sometimes be the staler of the two even when both exist; and for manual
 * accounts where institution_price doesn't exist at all, the security
 * snapshot wins by default.
 *
 * Walk-back semantics on the security side: we use the most recent security
 * entry whose `yearMonth` is on or before the requested view date. We never
 * consume a future security snapshot — viewing March 2026 will not pull a
 * May 2026 snapshot, even if that's "more recent" in absolute terms.
 *
 * Fallback to inferred (`institution_value / quantity`) only when neither
 * source has a usable price.
 */
export const getPriceForHolding = ({
  holding,
  securityPriceIndex,
  date,
}: PriceForHoldingParams): PriceResult | null => {
  const { holding: h, snapshot } = holding;
  const { security_id, institution_price, institution_value, quantity } = h;
  const holdingDate = snapshot.date; // ISO string — same shape as PriceIndexEntry.sourceDate

  // Resolve a security entry, if any.
  let securityEntry: PriceIndexEntry | undefined;
  if (security_id) {
    const securityIndex = securityPriceIndex.get(security_id);
    if (securityIndex) {
      securityEntry = findLatestEntryLessThanOrEqual(
        securityIndex,
        getYearMonthString(date),
      );
      if (securityEntry && !(securityEntry.price > 0)) securityEntry = undefined;
    }
  }

  const hasInstitution =
    institution_price !== null && institution_price !== undefined && institution_price > 0;

  if (securityEntry && hasInstitution) {
    // Both available — most recent sourceDate wins, security wins on a tie.
    if (securityEntry.sourceDate >= holdingDate) {
      return { price: securityEntry.price, source: "market" };
    }
    return { price: institution_price as number, source: "institution" };
  }
  if (securityEntry) return { price: securityEntry.price, source: "market" };
  if (hasInstitution) return { price: institution_price as number, source: "institution" };

  // Fall back: infer from institution_value / quantity.
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
      // SELL: reduce quantity using average cost.
      // Plaid encodes sell quantities as NEGATIVE, so take the magnitude —
      // otherwise `-= quantity` would ADD shares and basis back instead of
      // removing them (cf. benchmark.ts, which already uses -Math.abs for sells).
      if (totalQuantity > 0) {
        const soldQuantity = Math.abs(quantity);
        const avgCost = totalCost / totalQuantity;
        const soldCost = avgCost * soldQuantity;
        totalCost -= soldCost;
        totalQuantity -= soldQuantity;

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
  securities: SecurityDictionary;
  investmentTransactions: InvestmentTransactionDictionary;
}

/**
 * Main calculation function that builds HoldingsValueData from snapshots and transactions.
 * Implements price fallback and cost basis inference as specified in the design doc.
 */
export const getHoldingsValueData = ({
  holdingSnapshots,
  securitySnapshots,
  securities,
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

      // Two-channel cash detection. EITHER predicate fires → row is cash:
      //
      // 1. Holding-side: `institution_price === 1`. Plaid (and every other
      //    broker) quotes 1 for cash because cash doesn't trade against
      //    itself. Catches deposit sweeps whose security row never gets a
      //    `securitySnapshot` written (no `close_price_as_of` → skipped by
      //    `upsertSecuritiesWithSnapshots`).
      // 2. Security-side: `Security.isCash` (type === "cash" /
      //    is_cash_equivalent / `CUR:*` ticker). Catches cash whose broker
      //    quote drifts off 1.0 (FX precision, stale quote).
      //
      // Cash rows report `cost_basis === value` → `unrealizedGain === 0`
      // and `returnPercent === 0%`. The `inferCostBasis` transaction-replay
      // path is skipped — Plaid encodes sweep deposits as `type='buy'`
      // with `price=1`, which would otherwise pile up a phantom basis.
      const isCash =
        holding.institution_price === 1 || securities.get(security_id)?.isCash === true;

      let finalCostBasis: number | null = isCash ? value : cost_basis;
      let costBasisInferred = false;

      if (!isCash && (cost_basis === null || cost_basis === 0) && quantity !== 0) {
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
        isCash,
      });

      holdingsValueData.set(holdingId, date, summary);
    });
  });

  return holdingsValueData;
};

// Note: React hook (useHoldingsValueData) is provided separately in the client barrel
// to avoid bundling React dependencies in pure calculation functions.

// ---------------------------------------------------------------------------
// Earnings calculation
// ---------------------------------------------------------------------------

export interface HoldingEarningsResult {
  holding_id: string;
  security_id: string;
  account_id: string;
  startValue: number;
  endValue: number;
  costBasis: number | null;
  costBasisInferred: boolean;
  /** endValue - costBasis (null when costBasis is unavailable) */
  unrealizedGain: number | null;
  /** endValue - startValue */
  periodReturn: number;
}

export interface EarningsResult {
  holdings: HoldingEarningsResult[];
  totalStartValue: number;
  totalEndValue: number;
  totalCostBasis: number | null;
  totalUnrealizedGain: number | null;
  totalPeriodReturn: number;
}

/**
 * Calculates earnings for all holdings over a given date range.
 *
 * For each holding the function resolves:
 * - startValue  — value at the *start* date (or 0 if no data before that point)
 * - endValue    — value at the *end* date   (or 0 if no data after that point)
 * - unrealizedGain = endValue − costBasis   (null when costBasis is unknown)
 * - periodReturn   = endValue − startValue
 *
 * @param holdingsValueData  Pre-computed holdings value history
 * @param startDate          Beginning of the period (inclusive)
 * @param endDate            End of the period (inclusive)
 */
export const getEarningsForPeriod = (
  holdingsValueData: HoldingsValueData,
  startDate: Date,
  endDate: Date
): EarningsResult => {
  const holdings: HoldingEarningsResult[] = [];

  let totalStartValue = 0;
  let totalEndValue = 0;
  let totalCostBasisAccum: number | null = 0;
  let totalUnrealizedGainAccum: number | null = 0;

  holdingsValueData.forEach((history, holding_id) => {
    const startSummary = history.get(startDate);
    const endSummary = history.get(endDate);

    // Skip holdings that have no data at all in the requested range
    if (!startSummary && !endSummary) return;

    const startValue = startSummary?.value ?? 0;
    const endValue = endSummary?.value ?? 0;

    // Use end-date snapshot for cost-basis / meta (most current view)
    const refSummary = endSummary ?? startSummary!;
    const { security_id, account_id, costBasis, costBasisInferred } = refSummary;

    const unrealizedGain =
      costBasis !== null ? endValue - costBasis : null;

    const periodReturn = endValue - startValue;

    holdings.push({
      holding_id,
      security_id,
      account_id,
      startValue,
      endValue,
      costBasis,
      costBasisInferred,
      unrealizedGain,
      periodReturn,
    });

    totalStartValue += startValue;
    totalEndValue += endValue;

    if (totalCostBasisAccum !== null) {
      if (costBasis !== null) {
        totalCostBasisAccum += costBasis;
      } else {
        // One unknown cost-basis makes the aggregate unknown
        totalCostBasisAccum = null;
      }
    }

    if (totalUnrealizedGainAccum !== null) {
      if (unrealizedGain !== null) {
        totalUnrealizedGainAccum += unrealizedGain;
      } else {
        totalUnrealizedGainAccum = null;
      }
    }
  });

  return {
    holdings,
    totalStartValue,
    totalEndValue,
    totalCostBasis: totalCostBasisAccum,
    totalUnrealizedGain: totalUnrealizedGainAccum,
    totalPeriodReturn: totalEndValue - totalStartValue,
  };
};
