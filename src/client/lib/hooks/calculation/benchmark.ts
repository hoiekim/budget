import { InvestmentTransactionType } from "plaid";
import { InvestmentTransactionDictionary, HoldingSnapshotDictionary, SecuritySnapshotDictionary } from "../../models/Data";

/**
 * Performance benchmarking math — money-weighted return (IRR) + index benchmark.
 *
 * Pure functions only — no React, no appContext. Components pass in the
 * relevant dictionaries from `appContext.data` and the per-account scope.
 * Methodology reference (Hoie 2026-05-16): MWR for "what did my money do",
 * benchmark TWR for "what would lump-sum buy-and-hold have returned over the
 * same window". MWR < benchmark for steady-DCA accounts is expected because
 * dollars contributed mid-window have spent less time earning — that's the
 * dollar-weighting effect, not strategy underperformance.
 *
 * See `~/budget/issues/377` for the widget scope.
 */

export interface CashFlow {
  /** Date the flow hit the account, as YYYY-MM-DD. */
  date: string;
  /** Signed amount. Positive = external deposit IN, negative = withdrawal OUT. */
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
 * Detect cash-shape holdings from a snapshot record. Mirrors the FE
 * `isCash` heuristic used in `HoldingsComposition` — Plaid surfaces cash
 * positions with `institution_price === 1` and no real cost basis, and
 * the wire serializer collapses null cost_basis to 0, so we accept both.
 */
const isCashShapeHolding = (h: { institution_price?: number | null; cost_basis?: number | null }) =>
  h.institution_price === 1 && (h.cost_basis === null || h.cost_basis === undefined || h.cost_basis === 0);

/**
 * Build the set of cash-shape security_ids for an account from the
 * latest holding snapshot of each (account, security). A security is
 * considered cash-shape if any of its snapshots looked cash-shape — we
 * conservatively classify the security itself, not per-snapshot.
 */
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

const DEFAULT_MATCH_WINDOW_DAYS = 7;

interface AssetLeg {
  date: string;
  amount: number;
  type: "buy" | "sell";
}

const daysBetween = (a: string, b: string): number => {
  const aT = new Date(a).getTime();
  const bT = new Date(b).getTime();
  return Math.abs(aT - bT) / (1000 * 60 * 60 * 24);
};

/**
 * Classify investment transactions for an account into the external
 * cash-flow stream needed for MWR computation. Internal reallocations
 * (buy-cash paired with a sell-asset, etc.) are dropped.
 *
 * Rules:
 *   - type='cash' subtype='deposit' → +abs(amount), external IN. Plaid
 *     reports these with negative amounts ("money coming in") so we flip.
 *   - type='cash' subtype='withdrawal' → -abs(amount), external OUT.
 *   - type='buy' on a cash-shape security with amount > $1 → external IN
 *     **unless** matched by an opposite-sign asset leg within ±7 days
 *     (then it's an internal sale-proceeds-returning-to-cash event).
 *   - type='sell' on a cash-shape security → external OUT unless matched.
 *   - Asset buy/sell and fee/dividend → internal, skipped.
 *
 * Dedupe: when both a `cash/deposit` and a `buy CASH` of the same
 * magnitude land on the same day (Plaid double-reports some deposits),
 * count only the explicit `cash/deposit` row.
 */
export const extractCashFlows = (
  investmentTransactions: InvestmentTransactionDictionary,
  holdingSnapshots: HoldingSnapshotDictionary,
  accountId: string,
  options: { matchWindowDays?: number } = {},
): CashFlow[] => {
  const matchWindow = options.matchWindowDays ?? DEFAULT_MATCH_WINDOW_DAYS;
  const cashSecs = cashSecurityIdsForAccount(holdingSnapshots, accountId);

  const allTxns: { date: string; type: string; subtype: string; security_id: string | null; amount: number; quantity: number }[] = [];
  investmentTransactions.forEach((t) => {
    if (t.account_id !== accountId) return;
    allTxns.push({
      date: t.date.slice(0, 10),
      type: t.type,
      subtype: t.subtype,
      security_id: t.security_id,
      amount: t.amount ?? 0,
      quantity: t.quantity ?? 0,
    });
  });

  // Asset legs = non-cash-shape buy/sell with non-zero quantity. The
  // matching heuristic looks for these to identify internal sweep moves.
  const assetLegs: AssetLeg[] = allTxns
    .filter((t) => {
      if (t.security_id == null) return false;
      if (cashSecs.has(t.security_id)) return false;
      if (t.type !== InvestmentTransactionType.Buy && t.type !== InvestmentTransactionType.Sell) return false;
      return t.quantity !== 0;
    })
    .map((t) => ({ date: t.date, amount: t.amount, type: t.type as "buy" | "sell" }));

  const isMatchedByAsset = (cashLeg: { date: string; type: string; amount: number }): boolean => {
    const target = Math.abs(cashLeg.amount);
    for (const a of assetLegs) {
      if (daysBetween(a.date, cashLeg.date) > matchWindow) continue;
      // Cash SELL (money out of sweep) matches an asset BUY funded from cash.
      if (cashLeg.type === "sell" && a.type !== "buy") continue;
      // Cash BUY (money into sweep) matches an asset SELL whose proceeds return.
      if (cashLeg.type === "buy" && a.type !== "sell") continue;
      if (Math.abs(Math.abs(a.amount) - target) < Math.max(0.5, target * 0.01)) return true;
    }
    return false;
  };

  // Dedupe set: (date, abs_amount) of explicit cash/deposit and cash/withdrawal rows.
  const explicitCashEvents = new Set<string>();
  for (const t of allTxns) {
    if (t.type === InvestmentTransactionType.Cash && (t.subtype === "deposit" || t.subtype === "withdrawal")) {
      explicitCashEvents.add(`${t.date}|${Math.abs(t.amount).toFixed(2)}`);
    }
  }

  const flowsByDate = new Map<string, number>();
  for (const t of allTxns) {
    if (t.type === InvestmentTransactionType.Cash && t.subtype === "deposit") {
      flowsByDate.set(t.date, (flowsByDate.get(t.date) ?? 0) + -t.amount);
      continue;
    }
    if (t.type === InvestmentTransactionType.Cash && t.subtype === "withdrawal") {
      flowsByDate.set(t.date, (flowsByDate.get(t.date) ?? 0) + -Math.abs(t.amount));
      continue;
    }
    if (t.security_id == null || !cashSecs.has(t.security_id)) continue;
    if (t.type === InvestmentTransactionType.Buy && t.amount > 1) {
      const key = `${t.date}|${t.amount.toFixed(2)}`;
      if (explicitCashEvents.has(key)) continue;
      if (isMatchedByAsset(t)) continue;
      flowsByDate.set(t.date, (flowsByDate.get(t.date) ?? 0) + t.amount);
    } else if (t.type === InvestmentTransactionType.Sell && Math.abs(t.amount) > 1) {
      const key = `${t.date}|${Math.abs(t.amount).toFixed(2)}`;
      if (explicitCashEvents.has(key)) continue;
      if (isMatchedByAsset(t)) continue;
      flowsByDate.set(t.date, (flowsByDate.get(t.date) ?? 0) + t.amount);
    }
  }

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
 * Solve the IRR equation:
 *   −V_start + Σᵢ (−Cᵢ / (1+r)^tᵢ) + V_end / (1+r)^T = 0
 *
 * Bisection over `[-0.99, 10]`. Returns `no_solution` when the sign
 * of NPV doesn't change between the bounds (rare; typically only
 * happens when V_start = 0 and flows + V_end yield a degenerate stream).
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
 *
 * `priceAt` is the price lookup function — typically a closure over
 * `data.securitySnapshots` that returns the close_price for a security
 * on a given date, with optional walk-back to the latest available
 * date ≤ requested.
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
 * Portfolio value at a given date: Σ(security_id) qty_at(t) × price_at(t).
 *   - qty_at(t) = latest holding_snapshot for (account, security) with date ≤ t.
 *   - price_at(t) for cash-shape = 1.
 *   - price_at(t) for non-cash = priceAt(security_id, t) from securitySnapshots.
 *
 * Returns 0 when no holding snapshots have been recorded yet.
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
    if (entry.isCash) {
      total += entry.qty * 1;
    } else {
      const price = priceAt(secId, date);
      if (price === null) return;
      total += entry.qty * price;
    }
  });
  return total;
};

/**
 * Build a price lookup function over `securitySnapshots`. For a given
 * (security_id, date) the function returns the close_price of the latest
 * snapshot whose date is ≤ the requested date. Returns null when no such
 * snapshot exists. Typical caller: VOO price lookup for the benchmark.
 */
export const buildPriceAt = (securitySnapshots: SecuritySnapshotDictionary) => {
  // Build a per-security sorted (date, price) array once for fast lookup.
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
