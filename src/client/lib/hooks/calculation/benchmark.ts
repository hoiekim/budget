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
 * **`qty(t)` is txn-derived** (Hoie 2026-05-16). For each non-cash security:
 *   qty(t) = qty_from_holding_snapshot_at_windowStart
 *          + Σ(buy.quantity − sell.quantity from txns in (windowStart, t])
 *
 * This guards against holdings that update faster than the txn stream — a
 * Plaid sync gap where the FE sees +N shares in `holding_snapshots` but the
 * corresponding `buy` txn hasn't landed yet would otherwise have IRR
 * "explain" the unaccounted value as growth and inflate the MWR. With this
 * txn-walk, the unaccounted shares are invisible to the widget until their
 * matching txn arrives.
 *
 * `windowStart` anchors pre-window history we can't reconstruct from txns
 * (the user may have years of holdings predating the snapshot history we
 * have). For `t = windowStart`, this collapses to "holding snapshot qty"
 * which is what we want for V_start.
 *
 * Returns 0 when no non-cash holding snapshots have been recorded yet.
 */
export const valueAt = (params: {
  date: string;
  windowStart: string;
  accountId: string;
  holdingSnapshots: HoldingSnapshotDictionary;
  investmentTransactions: InvestmentTransactionDictionary;
  priceAt: (securityId: string, date: string) => number | null;
}): number => {
  const { date, windowStart, accountId, holdingSnapshots, investmentTransactions, priceAt } = params;

  const cashSecs = cashSecurityIdsForAccount(holdingSnapshots, accountId);

  // qty per security at `date` = Σ(buy.quantity − sell.quantity) over all
  // txns at-or-before `date` (windowStart-inclusive). Anchor is implicit:
  // for users with no pre-windowStart txns and no pre-windowStart holding
  // snapshot, this collapses to "all positions came from observed buys."
  // The phantom-holding guard from before is preserved: any holding qty in
  // `holding_snapshots` that exceeds what txns can explain is invisible.
  const qtyBySec = new Map<string, number>();

  // 1) Pre-window holdings anchor: take the latest snapshot ≤ windowStart
  //    as the starting qty. Skipped when no such snapshot exists (e.g.
  //    accounts whose snapshot history begins later than `windowStart`).
  const anchorSnapDate = new Map<string, string>();
  holdingSnapshots.forEach((snap) => {
    if (snap.holding.account_id !== accountId) return;
    const snapDate = snap.snapshot.date.slice(0, 10);
    if (snapDate > windowStart) return;
    const curDate = anchorSnapDate.get(snap.holding.security_id);
    if (!curDate || snapDate > curDate) {
      anchorSnapDate.set(snap.holding.security_id, snapDate);
      qtyBySec.set(snap.holding.security_id, snap.holding.quantity ?? 0);
    }
  });

  // 2) Walk txns in (windowStart, date] and adjust qty per security.
  investmentTransactions.forEach((t) => {
    if (t.account_id !== accountId) return;
    if (t.security_id == null) return;
    if (cashSecs.has(t.security_id)) return;
    if (t.quantity == null || t.quantity === 0) return;
    if (t.type !== "buy" && t.type !== "sell") return;
    const txnDate = t.date.slice(0, 10);
    if (txnDate <= windowStart) return;
    if (txnDate > date) return;
    const signed = t.type === "buy" ? Math.abs(t.quantity) : -Math.abs(t.quantity);
    qtyBySec.set(t.security_id, (qtyBySec.get(t.security_id) ?? 0) + signed);
  });

  // 3) For securities with no pre-window snapshot anchor but with
  //    investment_transactions BEFORE windowStart (e.g. the user's first
  //    txn was in 2022 but our holding-snapshot history only starts in
  //    2025 — anchored-at-first-txn use case), build the anchor from
  //    txn history at-or-before windowStart.
  investmentTransactions.forEach((t) => {
    if (t.account_id !== accountId) return;
    if (t.security_id == null) return;
    if (cashSecs.has(t.security_id)) return;
    if (t.quantity == null || t.quantity === 0) return;
    if (t.type !== "buy" && t.type !== "sell") return;
    if (anchorSnapDate.has(t.security_id)) return; // anchor came from holding snap
    const txnDate = t.date.slice(0, 10);
    if (txnDate > windowStart) return; // already counted in step 2
    const signed = t.type === "buy" ? Math.abs(t.quantity) : -Math.abs(t.quantity);
    qtyBySec.set(t.security_id, (qtyBySec.get(t.security_id) ?? 0) + signed);
  });

  let total = 0;
  qtyBySec.forEach((qty, sid) => {
    if (cashSecs.has(sid)) return;
    if (qty <= 0) return;
    const price = priceAt(sid, date);
    if (price === null) return;
    total += qty * price;
  });
  return total;
};

/**
 * The earliest date for which we have *any* data for the account —
 * either a holding snapshot or an investment transaction. Used as the
 * "All" window start, and as the clamp floor for shorter windows.
 *
 * If the account has txn history that predates the holding snapshot
 * history (common — txns go back further), the earliest txn wins.
 */
export const earliestDataDate = (params: {
  accountId: string;
  holdingSnapshots: HoldingSnapshotDictionary;
  investmentTransactions: InvestmentTransactionDictionary;
}): string | null => {
  const { accountId, holdingSnapshots, investmentTransactions } = params;
  let earliest: string | null = null;
  holdingSnapshots.forEach((snap) => {
    if (snap.holding.account_id !== accountId) return;
    const d = snap.snapshot.date.slice(0, 10);
    if (!earliest || d < earliest) earliest = d;
  });
  investmentTransactions.forEach((t) => {
    if (t.account_id !== accountId) return;
    const d = t.date.slice(0, 10);
    if (!earliest || d < earliest) earliest = d;
  });
  return earliest;
};

/**
 * Build a price lookup function over `securitySnapshots` AND
 * `investmentTransactions`. For each security we merge both sources into
 * a date-sorted (date, price) list and return the latest entry ≤ the
 * query date.
 *
 * **Why merge txn prices** (Hoie 2026-05-17): Plaid's `securitySnapshots`
 * history typically starts at the user's first holdings-sync, which may
 * be much later than their first transaction. For a user who DCA'd into
 * VOO for years before our snapshot history began, `priceAt(VOO, 2023-05)`
 * with snapshot-only data falls back to the earliest known snapshot
 * (e.g. $545 in 2025) instead of the actual ~$381 in 2023 — that inflates
 * vStart and depresses the IRR on 3Y / All windows. Each `buy`/`sell`
 * carries a per-share execution price as of the txn date, giving us a
 * near-market price point at every transaction the user has ever made.
 * For regular DCA users that's a dense series; the snapshot-fallback
 * artifact only ever fires for securities the user has never transacted
 * in (rare).
 */
export const buildPriceAt = (
  securitySnapshots: SecuritySnapshotDictionary,
  investmentTransactions: InvestmentTransactionDictionary,
) => {
  const bySec = new Map<string, Array<{ date: string; price: number }>>();

  // Source 1: security_snapshots (Plaid's daily institutional close).
  securitySnapshots.forEach((snap) => {
    const close = snap.security.close_price;
    if (close == null) return;
    const arr = bySec.get(snap.security.security_id) ?? [];
    arr.push({ date: snap.snapshot.date.slice(0, 10), price: close });
    bySec.set(snap.security.security_id, arr);
  });

  // Source 2: investment_transactions buy/sell prices. Skip non-asset
  // types (dividends, fees, cash sweeps) since their `price` field
  // either isn't set or doesn't reflect market price.
  investmentTransactions.forEach((t) => {
    if (t.security_id == null) return;
    if (t.type !== InvestmentTransactionType.Buy && t.type !== InvestmentTransactionType.Sell) {
      return;
    }
    if (t.price == null || t.price <= 0) return;
    const arr = bySec.get(t.security_id) ?? [];
    arr.push({ date: t.date.slice(0, 10), price: t.price });
    bySec.set(t.security_id, arr);
  });

  bySec.forEach((arr) => arr.sort((a, b) => (a.date < b.date ? -1 : 1)));

  // Walks the merged price index for a security: prefer latest entry ≤ date,
  // fall back to earliest when the query date predates everything we know.
  return (securityId: string, date: string): number | null => {
    const arr = bySec.get(securityId);
    if (!arr || arr.length === 0) return null;
    let best: number | null = null;
    for (const entry of arr) {
      if (entry.date <= date) best = entry.price;
      else break;
    }
    if (best === null) best = arr[0].price; // pre-history fallback
    return best;
  };
};
