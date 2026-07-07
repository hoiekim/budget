import { useMemo } from "react";
import {
  HoldingSnapshotDictionary,
  InvestmentTransactionDictionary,
  SecuritySnapshotDictionary,
} from "../../models/Data";
import {
  buildPriceAt,
  computeQtyDivergence,
  earliestDataDate,
  type DivergentEntry,
} from "./benchmark";

/**
 * Shared computation surface for the holdings-vs-transactions divergence.
 * Consumed by `PerformanceBenchmark` (aggregate footnote), by
 * `HoldingsComposition` (red-dot on affected rows), and by
 * `HoldingProperties` ("Add transaction for N missing units" action on the
 * holding detail page). Kept out of the benchmark widget's local memo so
 * the three consumers stay in lockstep — same window, same detection, no
 * drift between what the widget flags and what the row / button surface.
 *
 * Returns per-security detail keyed by `security_id`, with direction
 * ("holdingExcess" = MWR-excluded surplus / "txnExcess" = transactions
 * ahead of the snapshot) so consumers can pick which action fits the row.
 */
export type DivergenceDirection = "holdingExcess" | "txnExcess";

export interface DivergenceEntry extends DivergentEntry {
  direction: DivergenceDirection;
  /** The account this divergence lives on — needed when the caller
   *  aggregates across multiple accounts (e.g. `AccountsDetailPage` with
   *  a combined performance widget). */
  account_id: string;
}

export interface DivergenceMap {
  /** Keyed by `security_id`. When the same security shows divergence on
   *  more than one account, the entries collapse by summing `deltaQty`
   *  and `deltaValue` — the FE surfaces don't distinguish the source
   *  account for the flag, but the underlying account_id list is
   *  preserved on `.accountIds`. */
  bySecurity: Map<
    string,
    {
      direction: DivergenceDirection;
      deltaQty: number;
      deltaValue: number;
      accountIds: string[];
    }
  >;
  /** Full ordered list (sorted by `deltaValue` desc) for the summary
   *  surfaces (widget footnote). */
  entries: DivergenceEntry[];
}

/**
 * `viewEndDate` (YYYY-MM-DD) pins the detection to the same window
 * boundary the `PerformanceBenchmark` widget is showing. Both surfaces
 * MUST use the same date — otherwise the widget footnote flags an
 * excluded holding while the composition table's red dot has already
 * evaluated at today, cleared it, and shows nothing (Hoie 2026-07-06:
 * "the yellow warning says check red flag above and there's no red flag
 * in holdings composition table"). Callers pass
 * `viewDate.getEndDate()` / `LocalDate` toString. Defaults to today
 * only if the caller genuinely wants today's snapshot.
 */
export const useHoldingDivergence = (
  accountIds: string[],
  data: {
    holdingSnapshots: HoldingSnapshotDictionary;
    investmentTransactions: InvestmentTransactionDictionary;
    securitySnapshots: SecuritySnapshotDictionary;
  },
  viewEndDate?: string,
): DivergenceMap => {
  const { holdingSnapshots, investmentTransactions, securitySnapshots } = data;
  // Stable key — array identity would break the memo on every render.
  const accountIdsKey = accountIds.slice().sort().join(",");

  return useMemo(() => {
    const ids = accountIdsKey.split(",").filter(Boolean);
    if (!ids.length) {
      return { bySecurity: new Map(), entries: [] };
    }

    // Window: 1y ending at `viewEndDate` (or today if omitted), floored at
    // earliest available data per account.
    const toIso = (d: Date) => d.toISOString().slice(0, 10);
    const windowEnd = viewEndDate ?? toIso(new Date());
    const oneYearAgoDate = new Date(windowEnd);
    oneYearAgoDate.setFullYear(oneYearAgoDate.getFullYear() - 1);
    const oneYearAgo = toIso(oneYearAgoDate);

    const priceAt = buildPriceAt(securitySnapshots, investmentTransactions);

    const bySecurity: DivergenceMap["bySecurity"] = new Map();
    const entries: DivergenceEntry[] = [];

    for (const id of ids) {
      const earliest = earliestDataDate({
        accountId: id,
        holdingSnapshots,
        investmentTransactions,
      });
      // Same clamp as PerformanceBenchmark.
      const windowStart = !earliest || earliest > oneYearAgo ? earliest ?? oneYearAgo : oneYearAgo;
      if (windowEnd <= windowStart) continue;

      const d = computeQtyDivergence({
        date: windowEnd,
        windowStart,
        accountId: id,
        holdingSnapshots,
        investmentTransactions,
        priceAt,
      });

      const merge = (
        e: DivergentEntry,
        direction: DivergenceDirection,
      ) => {
        entries.push({ ...e, direction, account_id: id });
        const existing = bySecurity.get(e.security_id);
        if (existing) {
          existing.deltaQty += e.deltaQty;
          existing.deltaValue += e.deltaValue;
          if (!existing.accountIds.includes(id)) existing.accountIds.push(id);
        } else {
          bySecurity.set(e.security_id, {
            direction,
            deltaQty: e.deltaQty,
            deltaValue: e.deltaValue,
            accountIds: [id],
          });
        }
      };

      d.divergentSecurities.forEach((e) => merge(e, "holdingExcess"));
      d.txnExcessSecurities.forEach((e) => merge(e, "txnExcess"));
    }

    entries.sort((a, b) => b.deltaValue - a.deltaValue);
    return { bySecurity, entries };
  }, [accountIdsKey, viewEndDate, holdingSnapshots, investmentTransactions, securitySnapshots]);
};
