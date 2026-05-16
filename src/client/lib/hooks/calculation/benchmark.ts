import { InvestmentTransactionType } from "plaid";
import { InvestmentTransactionDictionary, HoldingSnapshotDictionary, SecuritySnapshotDictionary } from "../../models/Data";

/**
 * Investment-performance benchmarking math — money-weighted return (IRR) of
 * the user's non-cash positions plus an index TWR for the same window.
 *
 * **Scope (Hoie 2026-05-16): cash is excluded.** The "portfolio" tracked here
 * is the user's non-cash holdings only (VOO etc.); cash positions (QACDS,
 * pending-settlement orphans, USD sweep balances) are deliberately ignored.
 * Every asset BUY counts as an external deposit into the asset portfolio and
 * every asset SELL counts as a withdrawal. Cash/deposit/withdrawal rows and
 * `fee/dividend` rows are skipped. This sidesteps the settlement-pending
 * complexity that surfaced in the v1 spike against real prod data — at the
 * cost of underreporting dividends/interest credited to cash. The
 * cash-inclusive version is tracked separately (see follow-up issue).
 *
 * Pure functions only — no React, no appContext. Components pass in the
 * relevant dictionaries from `appContext.data` and the per-account scope.
 */

export interface CashFlow {
  /** Date the flow hit the asset portfolio, as YYYY-MM-DD. */
  date: string;
  /**
   * Signed amount in account currency. Positive = asset purchased
   * (external IN, money entering the asset side from elsewhere).
   * Negative = asset sold (external OUT, money leaving the asset side).
   */
  amount: number;
}

export interface MwrResult {
  status: "ok" | "no_solution";
  /** Annualized rate (e.g. 0.1781 = 17.81%). Null when status != "ok". */
  annualized: number | null;
  /** Cumulative-over-window equivalent: (1 + annualized)^years - 1. */
  cumulative: number | null;
}

export interface BenchmarkResult {
  /** (priceEnd / priceStart) - 1 */
  cumulative: number;
  /** (1 + cumulative)^(1/years) - 1 */
  annualized: number;
}

/**
 * Cash-shape detector — mirrors the `isCash` heuristic in
 * `HoldingsComposition`. Same security may be cash-shape across all its
 * snapshots; we conservatively classify the *security_id* itself, so a
 * holding that ever appeared as cash-shape stays excluded from the
 * asset-portfolio view.
 */
const isCashShapeHolding = (h: { institution_price?: number | null; cost_basis?: number | null }) =>
  h.institution_price === 1 && (h.cost_basis === null || h.cost_basis === undefined || h.cost_basis === 0);

const cashSecurityIdsForAccount = (
  holdingSnapshots: HoldingSnapshotDictionary,
  accountId: string,
): Set<string> => {
  const out = new Set<string>();
  holdingSnapshots.forEach((snap) => {
    if (snap.holding.account_id !== accountId) return;
    if (isCashShapeHolding(snap.holding)) out.add(snap.holding.security_id);
  });
  return out;
};

/**
 * Build the external-flow stream from a user's investment transactions.
 *
 * **Cash-excluded model:** an "external flow" is any movement of money
 * into or out of the *asset side* of the portfolio. That maps onto Plaid's
 * `type` field cleanly:
 *
 *   - `type='buy'` on a non-cash security → external IN (+amount).
 *   - `type='sell'` on a non-cash security → external OUT (−|amount|).
 *   - Everything else (`cash/deposit`, `cash/withdrawal`, `fee/dividend`,
 *     `buy`/`sell` on cash-shape securities) → skipped. Those are cash-side
 *     events and we're not tracking cash.
 *
 * Same-day flows for the same account are summed.
 */
export const extractCashFlows = (
  investmentTransactions: InvestmentTransactionDictionary,
  holdingSnapshots: HoldingSnapshotDictionary,
  accountId: string,
): CashFlow[] => {
  const cashSecs = cashSecurityIdsForAccount(holdingSnapshots, accountId);
  const flowsByDate = new Map<string, number>();

  investmentTransactions.forEach((t) => {
    if (t.account_id !== accountId) return;
    if (t.security_id == null) return;
    if (cashSecs.has(t.security_id)) return; // cash-side event, skip
    if (t.quantity == null || t.quantity === 0) return; // qty=0 rows aren't real asset moves
    if (t.type !== InvestmentTransactionType.Buy && t.type !== InvestmentTransactionType.Sell) return;

    const date = t.date.slice(0, 10);
    const signed = t.type === InvestmentTransactionType.Buy ? t.amount : -Math.abs(t.amount);
    flowsByDate.set(date, (flowsByDate.get(date) ?? 0) + signed);
  });

  return Array.from(flowsByDate.entries())
    .map(([date, amount]) => ({ date, amount }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
};

const yearsBetween = (start: string, end: string): number => {
  const startT = new Date(start).getTime();
  const endT = new Date(end).getTime();
  return Math.max((endT - startT) / (1000 * 60 * 60 * 24 * 365), 0.001);
};

/**
 * Solve the IRR equation for the asset-side cash flows:
 *   −V_start + Σᵢ (−Cᵢ / (1+r)^tᵢ) + V_end / (1+r)^T = 0
 *
 * `V_start` and `V_end` are the non-cash asset values at the window
 * boundaries (cash positions excluded — see `valueAt`).
 *
 * Bisection over `[-0.99, 10]`. Returns `no_solution` when the sign of NPV
 * doesn't change between the bounds.
 */
export const computeMWR = (params: {
  flows: CashFlow[];
  vStart: number;
  vEnd: number;
  windowStart: string;
  windowEnd: string;
}): MwrResult => {
  const { flows, vStart, vEnd, windowStart, windowEnd } = params;
  const years = yearsBetween(windowStart, windowEnd);
  const tEnd = years;

  const npv = (rate: number): number => {
    let total = -vStart;
    for (const f of flows) {
      const t = yearsBetween(windowStart, f.date);
      total += -f.amount / Math.pow(1 + rate, t);
    }
    total += vEnd / Math.pow(1 + rate, tEnd);
    return total;
  };

  const lo0 = -0.99;
  const hi0 = 10.0;
  if (npv(lo0) * npv(hi0) > 0) {
    return { status: "no_solution", annualized: null, cumulative: null };
  }
  let lo = lo0;
  let hi = hi0;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (npv(mid) * npv(lo) <= 0) hi = mid;
    else lo = mid;
  }
  const annualized = (lo + hi) / 2;
  const cumulative = Math.pow(1 + annualized, years) - 1;
  return { status: "ok", annualized, cumulative };
};

/**
 * Benchmark return for a passive security held over the same window.
 * For an ETF like VOO with no contributions, TWR = simple price ratio.
 */
export const computeBenchmarkTWR = (params: {
  priceStart: number;
  priceEnd: number;
  windowStart: string;
  windowEnd: string;
}): BenchmarkResult => {
  const { priceStart, priceEnd, windowStart, windowEnd } = params;
  const years = yearsBetween(windowStart, windowEnd);
  const cumulative = priceEnd / priceStart - 1;
  const annualized = Math.pow(1 + cumulative, 1 / years) - 1;
  return { cumulative, annualized };
};

/**
 * Non-cash asset value at a given date: Σ(non_cash_security_id) qty(t) × price(t).
 *
 * Cash-shape holdings (per `isCashShapeHolding`) are excluded — the
 * widget's scope is the asset portfolio, not the total account.
 *
 * Returns 0 when no non-cash holding snapshots have been recorded yet.
 */
export const valueAt = (params: {
  date: string;
  accountId: string;
  holdingSnapshots: HoldingSnapshotDictionary;
  priceAt: (securityId: string, date: string) => number | null;
}): number => {
  const { date, accountId, holdingSnapshots, priceAt } = params;
  // Per-security latest snapshot ≤ date
  const latestBySec = new Map<string, { date: string; qty: number; isCash: boolean }>();
  holdingSnapshots.forEach((snap) => {
    if (snap.holding.account_id !== accountId) return;
    const snapDate = snap.snapshot.date.slice(0, 10);
    if (snapDate > date) return;
    const cur = latestBySec.get(snap.holding.security_id);
    if (!cur || snapDate > cur.date) {
      latestBySec.set(snap.holding.security_id, {
        date: snapDate,
        qty: snap.holding.quantity ?? 0,
        isCash: isCashShapeHolding(snap.holding),
      });
    }
  });

  let total = 0;
  latestBySec.forEach((entry, secId) => {
    if (entry.qty === 0) return;
    if (entry.isCash) return; // cash-excluded
    const price = priceAt(secId, date);
    if (price === null) return;
    total += entry.qty * price;
  });
  return total;
};

/**
 * Build a price lookup function over `securitySnapshots`. For a given
 * (security_id, date) the function returns the close_price of the latest
 * snapshot whose date is ≤ the requested date. Returns null when no such
 * snapshot exists.
 */
export const buildPriceAt = (securitySnapshots: SecuritySnapshotDictionary) => {
  const bySec = new Map<string, Array<{ date: string; price: number }>>();
  securitySnapshots.forEach((snap) => {
    const close = snap.security.close_price;
    if (close == null) return;
    const arr = bySec.get(snap.security.security_id) ?? [];
    arr.push({ date: snap.snapshot.date.slice(0, 10), price: close });
    bySec.set(snap.security.security_id, arr);
  });
  bySec.forEach((arr) => arr.sort((a, b) => (a.date < b.date ? -1 : 1)));

  return (securityId: string, date: string): number | null => {
    const arr = bySec.get(securityId);
    if (!arr || arr.length === 0) return null;
    let best: number | null = null;
    for (const entry of arr) {
      if (entry.date <= date) best = entry.price;
      else break;
    }
    return best;
  };
};

/**
 * Resolve the security_id for a benchmark ticker (default VOO) from
 * `securitySnapshots`. Returns null if the ticker has no security row.
 */
export const findBenchmarkSecurityId = (
  securitySnapshots: SecuritySnapshotDictionary,
  ticker: string,
): string | null => {
  let found: string | null = null;
  securitySnapshots.forEach((snap) => {
    if (found) return;
    if (snap.security.ticker_symbol === ticker) found = snap.security.security_id;
  });
  return found;
};
