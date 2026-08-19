import { InvestmentTransactionType } from "plaid";
import { InvestmentTransactionDictionary, HoldingSnapshotDictionary, SecuritySnapshotDictionary } from "../../models/Data";

/**
 * Investment-performance benchmarking math — money-weighted return (IRR) of
 * the user's non-cash positions plus an index TWR for the same window.
 *
 * **Scope: cash is excluded.** The "portfolio" tracked here
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
 * Per-security external-flow streams from a user's investment transactions.
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
 * Same-day flows for the same (account, security) are summed. The returned
 * map is keyed by `security_id`, each value date-sorted ascending. Used by
 * `extractCashFlows` (account-wide MWR) and the per-holding S&P 500
 * benchmark column, which needs flows scoped to one ticker bucket.
 */
export const extractCashFlowsBySecurity = (
  investmentTransactions: InvestmentTransactionDictionary,
  holdingSnapshots: HoldingSnapshotDictionary,
  accountId: string,
): Map<string, CashFlow[]> => {
  const cashSecs = cashSecurityIdsForAccount(holdingSnapshots, accountId);
  const bySecDate = new Map<string, Map<string, number>>();

  investmentTransactions.forEach((t) => {
    if (t.account_id !== accountId) return;
    if (t.security_id == null) return;
    if (cashSecs.has(t.security_id)) return; // cash-side event, skip
    if (t.quantity == null || t.quantity === 0) return; // qty=0 rows aren't real asset moves
    if (t.type !== InvestmentTransactionType.Buy && t.type !== InvestmentTransactionType.Sell) return;

    const date = t.date.slice(0, 10);
    const signed = t.type === InvestmentTransactionType.Buy ? t.amount : -Math.abs(t.amount);
    const byDate = bySecDate.get(t.security_id) ?? new Map<string, number>();
    byDate.set(date, (byDate.get(date) ?? 0) + signed);
    bySecDate.set(t.security_id, byDate);
  });

  const out = new Map<string, CashFlow[]>();
  bySecDate.forEach((byDate, securityId) => {
    out.set(
      securityId,
      Array.from(byDate.entries())
        .map(([date, amount]) => ({ date, amount }))
        .sort((a, b) => (a.date < b.date ? -1 : 1)),
    );
  });
  return out;
};

/**
 * Account-wide external-flow stream — the per-security flows from
 * `extractCashFlowsBySecurity` merged across all (optionally filtered)
 * securities, summing same-day amounts. `securityIds`, when given, keeps
 * only flows for those securities (the per-bucket benchmark passes a
 * ticker bucket's security_ids).
 */
export const extractCashFlows = (
  investmentTransactions: InvestmentTransactionDictionary,
  holdingSnapshots: HoldingSnapshotDictionary,
  accountId: string,
  securityIds?: ReadonlySet<string>,
): CashFlow[] => {
  const bySec = extractCashFlowsBySecurity(investmentTransactions, holdingSnapshots, accountId);
  const flowsByDate = new Map<string, number>();

  bySec.forEach((flows, securityId) => {
    if (securityIds && !securityIds.has(securityId)) return;
    for (const f of flows) flowsByDate.set(f.date, (flowsByDate.get(f.date) ?? 0) + f.amount);
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

  // Degenerate input: no asset value at either boundary and no flows in
  // between. npv ≡ 0 for all rates, and the bisection below would happily
  // converge on the lower bound (−0.99) and report a fake −99% return.
  if (vStart === 0 && vEnd === 0 && flows.length === 0) {
    return { status: "no_solution", annualized: null, cumulative: null };
  }

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
  // Defense-in-depth: if either endpoint NPV is exactly 0 (or signs already
  // agree), there is no sign change to bisect on, so don't bisect.
  if (npv(lo0) * npv(hi0) >= 0) {
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

export interface TwrResult {
  status: "ok" | "insufficient_data";
  /** Cumulative time-weighted return over the window: Π(1+HPRᵢ) − 1. */
  cumulative: number | null;
  /** Annualized equivalent: (1 + cumulative)^(1/years) − 1. */
  annualized: number | null;
}

/**
 * Time-weighted return of the asset portfolio over [windowStart, windowEnd].
 *
 * TWR strips out *when* and *how much* the user contributed — unlike
 * `computeMWR` (dollar-weighted), which rewards or penalizes contribution
 * timing. It chain-links the holding-period return of the existing position
 * across the sub-periods bounded by each external cash flow:
 *
 *   HPRᵢ = (V(bᵢ) − CFᵢ) / V(bᵢ₋₁)          TWR = Π HPRᵢ − 1
 *
 * where `bᵢ` walks windowStart → each interior flow date → windowEnd, `V(b)`
 * is the asset value at `b` from the passed `valueAt` closure, and `CFᵢ` is
 * the flow landing on `bᵢ` (buy = +, sell = −). Because `valueAt` values
 * shares the same day they're bought (same-date-inclusive, matching how the
 * MWR's `vStart`/`vEnd` are taken), subtracting `CFᵢ` at the closing boundary
 * isolates the period's *market* move from the new money — the flow then
 * re-enters as the opening value of the next sub-period.
 *
 * **Boundary-value approximation.** `CFᵢ` is the flow's cash at its execution
 * price while `V(bᵢ)` prices that day's shares at the close, so when execution
 * ≠ close the per-period return carries that small basis error — the same
 * modeled-price limitation the MWR already lives with (see `buildPriceAt`).
 * Sub-periods opening on a zero/negative asset base (position not yet funded,
 * or fully liquidated then re-funded) are skipped rather than treated as ±∞
 * returns; the chain resumes at the next funded boundary. Returns
 * `insufficient_data` when no sub-period has a positive opening base.
 */
export const computeTWR = (params: {
  flows: CashFlow[];
  valueAt: (date: string) => number;
  windowStart: string;
  windowEnd: string;
}): TwrResult => {
  const { flows, valueAt, windowStart, windowEnd } = params;

  // Sum flows per date (defensive — extractCashFlows already dedups by date).
  // A flow on windowStart belongs to the opening value; one on windowEnd is
  // subtracted from the closing value (it earned no time in the window),
  // mirroring the MWR's `f.date > windowStart && f.date <= windowEnd` filter.
  const cfByDate = new Map<string, number>();
  for (const f of flows) {
    if (f.date <= windowStart || f.date > windowEnd) continue;
    cfByDate.set(f.date, (cfByDate.get(f.date) ?? 0) + f.amount);
  }

  // Ordered boundaries: windowStart, each interior flow date, windowEnd. A
  // flow exactly on windowEnd is not its own boundary — it folds into the
  // final sub-period's closing subtraction.
  const interior = Array.from(cfByDate.keys())
    .filter((d) => d < windowEnd)
    .sort((a, b) => (a < b ? -1 : 1));
  const boundaries = [windowStart, ...interior, windowEnd];

  let product = 1;
  let counted = 0;
  for (let i = 1; i < boundaries.length; i++) {
    const base = valueAt(boundaries[i - 1]);
    if (base <= 0) continue; // segment not funded yet / fully closed — skip
    const cf = cfByDate.get(boundaries[i]) ?? 0; // 0 at windowEnd w/o a flow
    const endBeforeFlow = valueAt(boundaries[i]) - cf;
    if (endBeforeFlow <= 0) continue; // modeled anomaly (exec ≪ close) — skip
    product *= endBeforeFlow / base;
    counted += 1;
  }

  if (counted === 0) {
    return { status: "insufficient_data", cumulative: null, annualized: null };
  }

  const cumulative = product - 1;
  const years = yearsBetween(windowStart, windowEnd);
  const annualized = Math.pow(1 + cumulative, 1 / years) - 1;
  return { status: "ok", cumulative, annualized };
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
 * What the portfolio would be worth right now if every dollar the user put
 * in had gone into the benchmark instead. `vStart` is replayed as a
 * windowStart-dated contribution (it represents money already invested at
 * window open); each in-window flow is re-priced at its OWN date — same
 * dynamic-distribution shape `computeHoldingBenchmark` uses for the
 * per-holding what-if. Returns null when `benchmarkPriceAt` can't price
 * windowStart or any flow date, since a partial answer would be misleading.
 */
export const computeBenchmarkEndValue = (params: {
  vStart: number;
  flows: CashFlow[];
  benchmarkPriceAt: (date: string) => number | null;
  windowStart: string;
  windowEnd: string;
}): number | null => {
  const { vStart, flows, benchmarkPriceAt, windowStart, windowEnd } = params;
  const priceStart = benchmarkPriceAt(windowStart);
  const priceEnd = benchmarkPriceAt(windowEnd);
  if (priceStart == null || priceStart <= 0 || priceEnd == null || priceEnd <= 0) return null;
  let value = vStart * (priceEnd / priceStart);
  for (const f of flows) {
    const p = benchmarkPriceAt(f.date);
    if (p == null || p <= 0) return null;
    value += f.amount * (priceEnd / p);
  }
  return value;
};

/**
 * Txn-derived quantity per security at `date`, windowStart-anchored. Shared
 * by `valueAt` (asset valuation) and `computeQtyDivergence` (the
 * holdings-vs-transactions reconciliation surface) so both see the identical
 * qty walk.
 *
 * **`qty(t)` is txn-derived.** For each security:
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
 * have). For `t = windowStart`, this collapses to "holding snapshot qty".
 *
 * The returned map may contain cash-shape securities (from the step-1
 * anchor); callers filter them via `cashSecs`.
 */
const txnDerivedQtyBySecurity = (params: {
  date: string;
  windowStart: string;
  accountId: string;
  holdingSnapshots: HoldingSnapshotDictionary;
  investmentTransactions: InvestmentTransactionDictionary;
  cashSecs: Set<string>;
}): Map<string, number> => {
  const { date, windowStart, accountId, holdingSnapshots, investmentTransactions, cashSecs } = params;

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

  return qtyBySec;
};

/**
 * Given a requested `windowStart`, return the earliest date ≥ `windowStart`
 * at which `priceIndex.priceEntryAt(sid, requestedWindowStart)` can price
 * EVERY non-cash security the account holds at requestedWindowStart using
 * an exact-match entry (i.e. `sourceDate === date`, not a stale-forward or
 * pre-history fallback).
 *
 * Motivation: TWR telescopes to `priceAt(windowEnd) / priceAt(windowStart)`.
 * When `priceAt(windowStart)` falls back — stale-forward to an older prior
 * txn (dates between txns in the pre-snapshot era) or pre-history to
 * `arr[0].price` (dates before the first surviving entry) — the account's
 * effective TWR starts from the fallback's actual source date, but the
 * label and the benchmark compare-to still use the requested date. The
 * mismatch produces a directional divergence that grows with window
 * width (a longer window puts requestedWindowStart deeper into the
 * fallback-prone pre-snapshot era). This helper computes the honest
 * "effective start" so the caller can re-anchor the whole window (label +
 * account valueAt + benchmark) to a single date the calc CAN price
 * exactly for every asset security.
 *
 * Rules:
 *   - For each in-scope account, walk EVERY non-cash security the account
 *     touches — via any holdings snapshot OR any investment_transaction.
 *     This is deliberately WIDER than "held at requestedWindowStart":
 *     the narrow set would miss the pre-first-txn case (all held qtys
 *     are 0 at the requested date, so no security would drive the shift
 *     and the effective start would collapse back to the requested one)
 *     and the "security starts being held mid-window but its data doesn't
 *     exist until even later" case.
 *   - For each such security, if `priceEntryAt(sid, requestedWindowStart)`
 *     returned an entry whose `sourceDate === requestedWindowStart` (an
 *     exact match), no shift needed for that security.
 *   - Otherwise ask `earliestOnOrAfter(sid, requestedWindowStart)` for the
 *     first exact-match entry AT OR AFTER the requested date. That
 *     entry's date is a candidate effective start.
 *   - Take the LATEST candidate across all securities — every asset
 *     security needs an honest same-date price at the effective start,
 *     so the aggregate `valueAt` doesn't mix a fresh price for one with
 *     a stale fallback for another.
 *   - When no security's index has any entry on or after
 *     `requestedWindowStart` (rare: an account whose only priceable
 *     entries all predate the requested window), return
 *     `requestedWindowStart` unchanged — nothing to shift toward, the
 *     caller falls through to the existing legacy behavior.
 *   - Cash-shape securities are excluded, matching `valueAt`'s scope.
 */
export const computeEffectiveWindowStart = (params: {
  requestedWindowStart: string;
  accountIds: readonly string[];
  holdingSnapshots: HoldingSnapshotDictionary;
  investmentTransactions: InvestmentTransactionDictionary;
  priceIndex: PriceIndex;
}): string => {
  const { requestedWindowStart, accountIds, holdingSnapshots, investmentTransactions, priceIndex } =
    params;
  let effective = requestedWindowStart;
  for (const accountId of accountIds) {
    const cashSecs = cashSecurityIdsForAccount(holdingSnapshots, accountId);
    // Collect every non-cash security the account touches — via any holdings
    // snapshot or any investment_transaction. This is deliberately WIDER
    // than "held at requestedWindowStart" (which would miss the pre-first-
    // txn case where every security has qty=0 at requestedWindowStart, and
    // also miss a security that STARTS being held later in the window but
    // whose data doesn't exist until an even later date). The narrow set
    // would shift to `requestedWindowStart` and pretend the position is
    // priceable, when it isn't.
    const relevantSecIds = new Set<string>();
    holdingSnapshots.forEach((snap) => {
      if (snap.holding.account_id !== accountId) return;
      if (cashSecs.has(snap.holding.security_id)) return;
      relevantSecIds.add(snap.holding.security_id);
    });
    investmentTransactions.forEach((t) => {
      if (t.account_id !== accountId) return;
      if (t.security_id == null) return;
      if (cashSecs.has(t.security_id)) return;
      relevantSecIds.add(t.security_id);
    });
    relevantSecIds.forEach((sid) => {
      const entry = priceIndex.priceEntryAt(sid, requestedWindowStart);
      if (!entry) return; // security has no priceable data at all — nothing to shift toward
      if (entry.sourceDate === requestedWindowStart) return; // exact match, no shift needed
      const next = priceIndex.earliestOnOrAfter(sid, requestedWindowStart);
      if (!next) return; // no future data for this security either; leave effective alone
      if (next.sourceDate > effective) effective = next.sourceDate;
    });
  }
  return effective;
};

/**
 * Non-cash asset value at a given date: Σ(non_cash_security_id) qty(t) × price(t).
 *
 * Cash-shape holdings (per `isCashShapeHolding`) are excluded — the
 * widget's scope is the asset portfolio, not the total account. `qty(t)` is
 * the txn-derived walk from `txnDerivedQtyBySecurity` (see its docstring for
 * the phantom-holding guard).
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
  const qtyBySec = txnDerivedQtyBySecurity({
    date,
    windowStart,
    accountId,
    holdingSnapshots,
    investmentTransactions,
    cashSecs,
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
 * Holdings-vs-transactions reconciliation for the account, evaluated at
 * `date`. Flags the non-cash securities whose latest holdings snapshot
 * (what the user actually owns per Plaid's holdings stream) shows more
 * shares than the transaction stream can explain (`txnDerivedQtyBySecurity`).
 *
 * Those surplus shares are *invisible* to `valueAt`/the MWR — the widget
 * intentionally values only the txn-explained position (the phantom-holding
 * guard that prevents IRR inflation). The trade-off is that on accounts
 * whose Plaid txn stream is genuinely incomplete, the MWR is computed on
 * fewer shares than the user holds, understating the return. This surface
 * lets the widget tell the user *why* — rather than silently reporting a
 * number off the full position. Self-heals once the matching buy txns land.
 *
 * Sub-0.1%-of-owned drift is ignored so fractional-share rounding (dividend
 * reinvestment) doesn't produce false flags.
 */
/** One divergent security, in either direction. Per-security detail lets
 *  the tooltip surface which ticker + how much rather than an aggregate. */
export interface DivergentEntry {
  security_id: string;
  /** Absolute qty delta (positive on both sides — direction is the map key). */
  deltaQty: number;
  /** deltaQty × priceAt (0 when no price is available). */
  deltaValue: number;
}

export interface QtyDivergence {
  // ── Direction A: holdings snapshot > txn-explained (Plaid holdings ahead).
  // "Shares you own that transactions can't explain yet — the MWR excludes
  // them until matching buy txns land."
  /** # of non-cash securities the user owns more of than txns explain. */
  divergentSecurityCount: number;
  /** Est. market value of the excluded surplus shares at `date`. The MWR
   *  values the position MINUS this amount. */
  excludedValue: number;
  /** Per-security detail sorted by `deltaValue` desc so the tooltip lists
   *  the load-bearing ones first. */
  divergentSecurities: DivergentEntry[];

  // ── Direction B: txn-explained > holdings snapshot (transactions ahead).
  // Covers (i) the manual-mint case (invtx recorded for a security with no
  // matching holdings row) and (ii) the Plaid-lag reverse case (a sale txn
  // arrived but the snapshot still shows the pre-sale qty). Symmetric shape
  // with direction A; sub-0.1% ignore threshold shared. gap 1.
  /** # of non-cash securities the txn stream records but that the latest
   *  holdings snapshot doesn't reflect at full qty (or at all). */
  txnExcessSecurityCount: number;
  /** Est. value of the transactions-only shares at `date` (using the same
   *  `priceAt` fallback used for direction A). */
  txnExcessValue: number;
  /** Per-security detail sorted by `deltaValue` desc. */
  txnExcessSecurities: DivergentEntry[];
}

export const computeQtyDivergence = (params: {
  date: string;
  windowStart: string;
  accountId: string;
  holdingSnapshots: HoldingSnapshotDictionary;
  investmentTransactions: InvestmentTransactionDictionary;
  priceAt: (securityId: string, date: string) => number | null;
}): QtyDivergence => {
  const { date, windowStart, accountId, holdingSnapshots, investmentTransactions, priceAt } = params;

  const cashSecs = cashSecurityIdsForAccount(holdingSnapshots, accountId);
  const seenQty = txnDerivedQtyBySecurity({
    date,
    windowStart,
    accountId,
    holdingSnapshots,
    investmentTransactions,
    cashSecs,
  });

  // Latest holdings-snapshot qty at-or-before `date` per non-cash security —
  // the shares the user actually owns per Plaid's holdings stream.
  const ownedQty = new Map<string, number>();
  const ownedDate = new Map<string, string>();
  holdingSnapshots.forEach((snap) => {
    if (snap.holding.account_id !== accountId) return;
    const sid = snap.holding.security_id;
    if (cashSecs.has(sid)) return;
    const snapDate = snap.snapshot.date.slice(0, 10);
    if (snapDate > date) return;
    const cur = ownedDate.get(sid);
    if (!cur || snapDate > cur) {
      ownedDate.set(sid, snapDate);
      ownedQty.set(sid, snap.holding.quantity ?? 0);
    }
  });

  let divergentSecurityCount = 0;
  let excludedValue = 0;
  const divergentSecurities: DivergentEntry[] = [];
  ownedQty.forEach((owned, sid) => {
    // Clamp the txn-derived baseline at 0 to mirror valueAt's `qty <= 0`
    // guard: valueAt contributes 0 (not a negative value) for a security
    // whose walk went net-short, so the shares it actually *excludes* are
    // `owned − max(0, seen)`, not `owned − seen`.
    const surplus = owned - Math.max(0, seenQty.get(sid) ?? 0);
    // Ignore sub-0.1%-of-owned drift (fractional-share reinvestment noise).
    if (surplus <= 0 || surplus <= Math.abs(owned) * 1e-3) return;
    divergentSecurityCount += 1;
    const price = priceAt(sid, date);
    const deltaValue = price !== null ? surplus * price : 0;
    excludedValue += deltaValue;
    divergentSecurities.push({ security_id: sid, deltaQty: surplus, deltaValue });
  });
  divergentSecurities.sort((a, b) => b.deltaValue - a.deltaValue);

  // Direction B: txn-explained > holdings snapshot. Walk the seen (txn)
  // qty map and check each non-cash security against the owned map. A
  // security appears here when either (i) the txn stream records positive
  // qty AND the holdings snapshot for the same `(account_id, security_id)`
  // is missing entirely — the manual-mint case: user recorded a buy but no
  // holding was ever created; OR (ii) the txn qty > the snapshot qty at
  // `date` — a Plaid-lag reverse case (sale txn arrived, snapshot still
  // pre-sale). The ignore threshold is 0.1% of `seen` — symmetric with
  // direction A's `Math.abs(owned) * 1e-3`.
  let txnExcessSecurityCount = 0;
  let txnExcessValue = 0;
  const txnExcessSecurities: DivergentEntry[] = [];
  seenQty.forEach((seen, sid) => {
    if (cashSecs.has(sid)) return;
    // Only positive-qty holdings are meaningful — a walked-net-short
    // security isn't "held" from either side's view.
    if (seen <= 0) return;
    const owned = ownedQty.get(sid) ?? 0;
    const excess = seen - owned;
    if (excess <= 0 || excess <= Math.abs(seen) * 1e-3) return;
    txnExcessSecurityCount += 1;
    const price = priceAt(sid, date);
    const deltaValue = price !== null ? excess * price : 0;
    txnExcessValue += deltaValue;
    txnExcessSecurities.push({ security_id: sid, deltaQty: excess, deltaValue });
  });
  txnExcessSecurities.sort((a, b) => b.deltaValue - a.deltaValue);

  return {
    divergentSecurityCount,
    excludedValue,
    divergentSecurities,
    txnExcessSecurityCount,
    txnExcessValue,
    txnExcessSecurities,
  };
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
 * Build a price lookup function for the user's MWR — merges
 * `security_snapshots` (Plaid's daily institutional close) with the
 * user's own `investment_transactions` buy/sell prices into a single
 * date-sorted (date, price) list per security. Returns the latest entry
 * ≤ the query date; falls back to the earliest known entry when the
 * query predates everything.
 *
 * **Why both sources:**
 *   - `price_at_windowEnd` needs the **exact date** market price.
 *     security_snapshots give that for any date Plaid has synced (≈
 *     last year), and the resolve-security-snapshot endpoint backfills
 *     anything older via Polygon (results land in snapshots → fed
 *     here on the next render).
 *   - `investment_transactions` cover historical dates Plaid's
 *     snapshot history doesn't reach (the user transacted before they
 *     hooked up the integration). Each buy/sell's per-share execution
 *     price is a near-market data point at that date.
 *
 * Together, snapshot wins at boundary dates that have one; txn fills
 * the long tail. For securities the user has never transacted in and
 * has no snapshot for, returns null.
 */
/**
 * One entry in the merged price index — the price value and the date it
 * came from. `sourceDate` may be BEFORE the query date (stale-forward
 * fallback), EQUAL to it (exact match), or AFTER it (pre-history
 * fallback via `arr[0]`).
 */
export interface PriceEntry {
  price: number;
  sourceDate: string;
}

/**
 * Merged price-index primitive. Exposes three lookups over one shared
 * per-security sorted array:
 *
 *   - `priceAt(sid, date)` — legacy API, returns just the price. Unchanged
 *     semantics (stable-sort keeps snapshot before txn on collision → txn
 *     wins the last-≤ walk; pre-history fallback to `arr[0].price`).
 *   - `priceEntryAt(sid, date)` — same walk, but returns `{price, sourceDate}`
 *     so the caller can detect fallback. Load-bearing for the
 *     `PerformanceBenchmark` window-anchor honesty fix: when
 *     `sourceDate !== date`, priceAt is pricing `date` from a different
 *     day's data, and the caller should either accept the fallback or
 *     shift the anchor to a date the index CAN price exactly.
 *   - `earliestOnOrAfter(sid, date)` — first entry whose `entry.date >=
 *     date`. Returns null when no such entry exists. Used to find the
 *     earliest date the account has honest price data for a security,
 *     given a requested window start. Same underlying array as the
 *     other two lookups.
 */
export interface PriceIndex {
  priceAt: (securityId: string, date: string) => number | null;
  priceEntryAt: (securityId: string, date: string) => PriceEntry | null;
  earliestOnOrAfter: (securityId: string, date: string) => PriceEntry | null;
}

export const buildPriceIndex = (
  securitySnapshots: SecuritySnapshotDictionary,
  investmentTransactions: InvestmentTransactionDictionary,
): PriceIndex => {
  const bySec = new Map<string, Array<{ date: string; price: number }>>();

  securitySnapshots.forEach((snap) => {
    const close = snap.security.close_price;
    if (close == null) return;
    const arr = bySec.get(snap.security.security_id) ?? [];
    arr.push({ date: snap.snapshot.date.slice(0, 10), price: close });
    bySec.set(snap.security.security_id, arr);
  });

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

  const lastOnOrBefore = (
    arr: Array<{ date: string; price: number }>,
    date: string,
  ): { date: string; price: number } | null => {
    let best: { date: string; price: number } | null = null;
    for (const entry of arr) {
      if (entry.date <= date) best = entry;
      else break;
    }
    return best;
  };

  return {
    priceAt: (securityId, date) => {
      const arr = bySec.get(securityId);
      if (!arr || arr.length === 0) return null;
      const hit = lastOnOrBefore(arr, date);
      if (hit) return hit.price;
      return arr[0].price; // pre-history fallback
    },
    priceEntryAt: (securityId, date) => {
      const arr = bySec.get(securityId);
      if (!arr || arr.length === 0) return null;
      const hit = lastOnOrBefore(arr, date);
      if (hit) return { price: hit.price, sourceDate: hit.date };
      return { price: arr[0].price, sourceDate: arr[0].date }; // pre-history fallback
    },
    earliestOnOrAfter: (securityId, date) => {
      const arr = bySec.get(securityId);
      if (!arr || arr.length === 0) return null;
      for (const entry of arr) {
        if (entry.date >= date) return { price: entry.price, sourceDate: entry.date };
      }
      return null;
    },
  };
};

/**
 * Legacy price-lookup API — the closure form of `buildPriceIndex().priceAt`.
 * Kept as-is so existing callers (`HoldingProperties`, `divergence.ts`) don't
 * churn. New callers that need `sourceDate` should use `buildPriceIndex`
 * directly and read `.priceEntryAt` / `.earliestOnOrAfter`.
 */
export const buildPriceAt = (
  securitySnapshots: SecuritySnapshotDictionary,
  investmentTransactions: InvestmentTransactionDictionary,
) => buildPriceIndex(securitySnapshots, investmentTransactions).priceAt;

/**
 * Snapshot-only price lookup for the benchmark side. Returns null when
 * no snapshot ≤ date exists — caller is expected to chain to a Polygon
 * resolve and/or a static CSV fallback. (Distinct from `buildPriceAt`,
 * which is txn-only and serves the user's MWR.)
 */
export const buildSnapshotPriceAt = (securitySnapshots: SecuritySnapshotDictionary) => {
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
 * Find the security_id for a benchmark ticker (e.g. VOO) from the user's
 * security_snapshots. Returns null if the ticker has no security row.
 * Used to route resolve-snapshot calls and snapshot lookups to the
 * correct security_id.
 */
export const findBenchmarkSecurityId = (
  securitySnapshots: SecuritySnapshotDictionary,
  ticker: string,
): string | null => {
  // Two rows can share a ticker (user-minted + provider-synced). Pick
  // the security_id whose snapshot chain has the freshest close so
  // benchmark math uses the most-updated series. Falls back to first-
  // iterating for ties on missing date (rare — snapshots always carry
  // a date).
  let found: string | null = null;
  let foundDate: string | null = null;
  securitySnapshots.forEach((snap) => {
    if (snap.security.ticker_symbol !== ticker) return;
    const d = snap.snapshot.date;
    if (!found || (d && (!foundDate || d > foundDate))) {
      found = snap.security.security_id;
      foundDate = d ?? null;
    }
  });
  return found;
};

/** One daily close from the static benchmark history CSV. */
export interface PriceRow {
  date: string;
  close: number;
}

/**
 * Latest close ≤ `date` in a date-sorted (ascending) price series. Mirrors
 * the snapshot `priceAt` walk; returns null when the series is empty or
 * every entry postdates `date`.
 */
export const priceAtIn = (history: PriceRow[], date: string): number | null => {
  if (history.length === 0) return null;
  let best: number | null = null;
  for (const r of history) {
    if (r.date <= date) best = r.close;
    else break;
  }
  return best;
};

/**
 * Benchmark price lookup with the standard fallback chain:
 * `security_snapshots` (Plaid daily close, including Polygon-resolved
 * backfills) first, static CSV history (`vooHistory`) for the long
 * historical tail. Returns null when neither source has a price ≤ date.
 *
 * Shared by `PerformanceBenchmark` (window TWR) and the Holdings
 * Composition S&P 500 benchmark column.
 */
export const buildBenchmarkPriceAt = (
  securitySnapshots: SecuritySnapshotDictionary,
  vooHistory: PriceRow[] | null,
  ticker = "VOO",
) => {
  const benchmarkSecurityId = findBenchmarkSecurityId(securitySnapshots, ticker);
  const snapPriceAt = buildSnapshotPriceAt(securitySnapshots);
  return (date: string): number | null => {
    if (benchmarkSecurityId) {
      const snap = snapPriceAt(benchmarkSecurityId, date);
      if (snap != null) return snap;
    }
    if (vooHistory && vooHistory.length > 0) {
      const csv = priceAtIn(vooHistory, date);
      if (csv != null) return csv;
    }
    return null;
  };
};

export interface HoldingBenchmarkResult {
  /** Hypothetical absolute G/L: hypotheticalValue − Σ contributed. */
  gain: number;
  /** Hypothetical %-return on the contributed dollars (gain / Σ × 100). */
  returnPercent: number;
}

/**
 * Dynamic-distribution S&P 500 benchmark for a single holding bucket.
 *
 * Each contribution `(dateᵢ, amountᵢ)` — buy = +amount, sell = −amount — is
 * re-priced forward at the index's return from its *own* date to `asOf`:
 *
 *   hypotheticalValue = Σ amountᵢ × price(asOf) / price(dateᵢ)
 *   gain              = hypotheticalValue − Σ amountᵢ
 *   returnPercent     = gain / Σ amountᵢ × 100
 *
 * No averaging of cost basis or contribution dates — uneven contributions
 * are each tracked at their own date, so the answer reflects *when* the
 * money went in, matching the holding's own money-weighted experience.
 *
 * Returns null when:
 *   - there are no contributions, or
 *   - net contributed ≤ 0 (can't express a %-return on a zero/negative
 *     basis — e.g. a fully-closed position), or
 *   - any contribution date (or `asOf`) has no index price available.
 */
export const computeHoldingBenchmark = (params: {
  contributions: CashFlow[];
  asOf: string;
  benchmarkPriceAt: (date: string) => number | null;
}): HoldingBenchmarkResult | null => {
  const { contributions, asOf, benchmarkPriceAt } = params;
  if (contributions.length === 0) return null;

  const priceEnd = benchmarkPriceAt(asOf);
  if (priceEnd == null || priceEnd <= 0) return null;

  let hypothetical = 0;
  let net = 0;
  for (const c of contributions) {
    const priceStart = benchmarkPriceAt(c.date);
    if (priceStart == null || priceStart <= 0) return null;
    hypothetical += c.amount * (priceEnd / priceStart);
    net += c.amount;
  }
  if (net <= 0) return null;

  const gain = hypothetical - net;
  return { gain, returnPercent: (gain / net) * 100 };
};
