import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  Account,
  useAppContext,
  call,
  Data,
  SecuritySnapshot,
  SecuritySnapshotDictionary,
  indexedDb,
  useVooHistory,
} from "client";
import type { ResolveSecuritySnapshotResponse } from "server/routes/accounts/post-resolve-security-snapshot";
import {
  extractCashFlows,
  computeMWR,
  computeBenchmarkTWR,
  computeBenchmarkEndValue,
  valueAt,
  buildPriceAt,
  buildSnapshotPriceAt,
  buildBenchmarkPriceAt,
  findBenchmarkSecurityId,
  earliestDataDate,
} from "client/lib/hooks/calculation/benchmark";
import "./index.css";

interface Props {
  accounts: Account[];
}

type WindowKey = "1Y" | "3Y" | "All";
const WINDOW_OPTIONS: WindowKey[] = ["1Y", "3Y", "All"];
const BENCHMARK_TICKER = "VOO";

const toDateString = (d: Date) => d.toISOString().slice(0, 10);

const formatPct = (n: number | null): string => {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
};

const formatSignedDollars = (n: number | null): string => {
  if (n === null || !Number.isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "−";
  const abs = Math.abs(Math.round(n));
  return `${sign}$${abs.toLocaleString("en-US")}`;
};

export const PerformanceBenchmark = ({ accounts }: Props) => {
  const accountIds = accounts.map((a) => a.account_id);
  // Stable string key for memo deps so array identity doesn't matter.
  const accountIdsKey = accountIds.slice().sort().join(",");
  const { data, setData, viewDate } = useAppContext();
  const { investmentTransactions, holdingSnapshots, securitySnapshots } = data;

  const [windowKey, setWindowKey] = useState<WindowKey>("1Y");
  const [displayMode, setDisplayMode] = useState<"pct" | "dollar">("pct");
  const toggleDisplayMode = () =>
    setDisplayMode((m) => (m === "pct" ? "dollar" : "pct"));
  // Space would otherwise scroll the page as well as toggle.
  const handleToggleKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleDisplayMode();
    }
  };
  const vooHistory = useVooHistory();
  // Already-attempted (security_id, date) keys for Polygon resolve so
  // retries don't loop on no_data/plan_limit and window-toggle re-renders
  // don't refetch.
  const attemptedResolveRef = useRef<Set<string>>(new Set());

  const computed = useMemo(() => {
    const ids = accountIdsKey.split(",").filter(Boolean);
    // "Earliest available data" is min across all accounts.
    let earliest: string | null = null;
    for (const id of ids) {
      const e = earliestDataDate({ accountId: id, holdingSnapshots, investmentTransactions });
      if (e && (!earliest || e < earliest)) earliest = e;
    }
    if (!earliest) return null;

    // windowEnd follows viewDate (end of the period the user is looking at),
    // capped at today since we have no future data. Same convention as
    // HoldingsComposition's `viewEndDate`.
    const today = new Date();
    const viewEnd = viewDate.getEndDate();
    const effectiveEnd = viewEnd > today ? today : viewEnd;
    const windowEnd = toDateString(effectiveEnd);
    const clampStart = (target: Date): { value: string; clamped: boolean } => {
      const t = toDateString(target);
      return t < earliest! ? { value: earliest!, clamped: true } : { value: t, clamped: false };
    };

    let windowStart: string;
    let isClamped = false;
    if (windowKey === "All") {
      windowStart = earliest;
    } else {
      const years = windowKey === "1Y" ? 1 : 3;
      const target = new Date(effectiveEnd);
      target.setFullYear(target.getFullYear() - years);
      const r = clampStart(target);
      windowStart = r.value;
      isClamped = r.clamped;
    }

    if (windowEnd <= windowStart) return null;

    // User-MWR priceAt merges security_snapshots (daily institutional
    // close from Plaid) with the user's own investment_transactions.
    // Snapshot wins for boundary dates that have one — including
    // anything Polygon has backfilled via resolve-security-snapshot.
    // Txn fills the long historical tail predating Plaid's sync.
    const priceAt = buildPriceAt(securitySnapshots, investmentTransactions);
    const vStart = ids.reduce(
      (sum, id) =>
        sum +
        valueAt({ date: windowStart, windowStart, accountId: id, holdingSnapshots, investmentTransactions, priceAt }),
      0,
    );
    const vEnd = ids.reduce(
      (sum, id) =>
        sum +
        valueAt({ date: windowEnd, windowStart, accountId: id, holdingSnapshots, investmentTransactions, priceAt }),
      0,
    );

    const flowsByDate = new Map<string, number>();
    for (const id of ids) {
      for (const f of extractCashFlows(investmentTransactions, holdingSnapshots, id)) {
        flowsByDate.set(f.date, (flowsByDate.get(f.date) ?? 0) + f.amount);
      }
    }
    const allFlows = Array.from(flowsByDate.entries())
      .map(([date, amount]) => ({ date, amount }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    const flows = allFlows.filter((f) => f.date > windowStart && f.date <= windowEnd);

    const mwr = computeMWR({ flows, vStart, vEnd, windowStart, windowEnd });

    // Benchmark TWR fallback chain: security_snapshots → static CSV.
    // (Polygon resolve fires async in a separate useEffect and merges
    // results back into security_snapshots, where they'll feed the next
    // render of this memo.)
    const benchmarkPriceAt = buildBenchmarkPriceAt(securitySnapshots, vooHistory, BENCHMARK_TICKER);
    let benchmark: ReturnType<typeof computeBenchmarkTWR> | null = null;
    const benchPriceStart = benchmarkPriceAt(windowStart);
    const benchPriceEnd = benchmarkPriceAt(windowEnd);
    if (benchPriceStart && benchPriceEnd) {
      benchmark = computeBenchmarkTWR({
        priceStart: benchPriceStart,
        priceEnd: benchPriceEnd,
        windowStart,
        windowEnd,
      });
    }

    const yearsInWindow =
      (new Date(windowEnd).getTime() - new Date(windowStart).getTime()) / (1000 * 60 * 60 * 24 * 365);
    const suppressAnnualized = yearsInWindow < 0.5;

    // Raw dollar counterparts to the percentage returns. Simple accounting:
    // `netContributed = vStart + Σ flows` is money the user put in over the
    // window (vStart is the position at window-open, treated as a
    // windowStart-dated contribution). `gain = vEnd − netContributed` is
    // what the portfolio ADDED beyond contributions — the raw counterpart
    // to MWR's cumulative %. Same shape for the VOO counterfactual and the
    // diff between them.
    const sumFlows = flows.reduce((s, f) => s + f.amount, 0);
    const netContributed = vStart + sumFlows;
    const mwrGain = mwr.status === "ok" ? vEnd - netContributed : null;

    const vooEndValue = computeBenchmarkEndValue({
      vStart,
      flows,
      benchmarkPriceAt,
      windowStart,
      windowEnd,
    });
    const benchmarkGain = vooEndValue !== null ? vooEndValue - netContributed : null;

    const gapPct =
      mwr.cumulative !== null && benchmark ? mwr.cumulative - benchmark.cumulative : null;
    const gapPctAnnualized =
      mwr.annualized !== null && benchmark ? mwr.annualized - benchmark.annualized : null;
    const gapDollars =
      mwrGain !== null && benchmarkGain !== null ? mwrGain - benchmarkGain : null;

    return {
      windowStart,
      windowEnd,
      vStart,
      vEnd,
      flowCount: flows.length,
      yearsInWindow,
      mwr,
      mwrGain,
      benchmark,
      benchmarkGain,
      gapPct,
      gapPctAnnualized,
      gapDollars,
      suppressAnnualized,
      isClamped,
    };
  }, [
    accountIdsKey,
    investmentTransactions,
    holdingSnapshots,
    securitySnapshots,
    windowKey,
    viewDate,
    vooHistory,
  ]);

  // Async tier of the benchmark fallback chain: when security_snapshots
  // are missing a price for windowStart or windowEnd, fire a Polygon
  // resolve and merge the returned snapshot into AppContext. Subsequent
  // renders pick it up via the memo's `securitySnapshots` dep. The static
  // CSV already renders the sync fallback, so this just upgrades the
  // snapshot store; it doesn't block first paint.
  useEffect(() => {
    if (!computed) return;
    const vooSecurityId = findBenchmarkSecurityId(securitySnapshots, BENCHMARK_TICKER);
    if (!vooSecurityId) return;
    const snapPriceAt = buildSnapshotPriceAt(securitySnapshots);
    const candidates = [computed.windowStart, computed.windowEnd];
    for (const date of candidates) {
      if (snapPriceAt(vooSecurityId, date) != null) continue;
      const key = `${vooSecurityId}:${date}`;
      if (attemptedResolveRef.current.has(key)) continue;
      attemptedResolveRef.current.add(key);
      call
        .post<ResolveSecuritySnapshotResponse>("/api/resolve-security-snapshot", {
          security_id: vooSecurityId,
          date,
        })
        .then((response) => {
          if (response.status !== "success" || !response.body) return;
          const resolved = response.body.snapshot;
          if (!resolved) return; // plan_limit / no_data — CSV already covered it
          const snap = new SecuritySnapshot(resolved);
          indexedDb.save(snap).catch(console.error);
          setData((oldData) => {
            const newData = new Data(oldData);
            const newSS = new SecuritySnapshotDictionary(newData.securitySnapshots);
            newSS.set(snap.snapshot.snapshot_id, snap);
            newData.securitySnapshots = newSS;
            return newData;
          });
        })
        .catch((err) => {
          console.warn("resolve-security-snapshot failed", err);
        });
    }
  }, [computed, securitySnapshots, setData]);

  if (!computed) return null;
  const {
    windowStart,
    windowEnd,
    yearsInWindow,
    mwr,
    mwrGain,
    benchmark,
    benchmarkGain,
    gapPct,
    gapPctAnnualized,
    gapDollars,
    suppressAnnualized,
    isClamped,
  } = computed;

  // Every value cell renders the same shape: a "total" line on top and, if
  // annualization isn't suppressed for short windows, a per-year line under
  // it in smaller grey. `renderValues` emits both. The diff row passes
  // `colorBySign` so the total goes green/red; MWR + benchmark stay neutral.
  const renderValues = (
    cumulative: number | null,
    perYear: number | null,
    fallback: string,
    formatter: (n: number | null) => string,
    colorBySign?: number | null,
  ): JSX.Element => {
    if (cumulative === null && perYear === null) {
      return <span className="no-data">{fallback}</span>;
    }
    const cumCls =
      colorBySign == null ? "cum" : `cum ${colorBySign >= 0 ? "positive" : "negative"}`;
    return (
      <>
        {cumulative !== null && <span className={cumCls}>{formatter(cumulative)}</span>}
        {!suppressAnnualized && perYear !== null && (
          <span className="ann">{formatter(perYear)}/yr</span>
        )}
      </>
    );
  };

  const perYear = (total: number | null): number | null =>
    total !== null && yearsInWindow > 0 ? total / yearsInWindow : null;

  return (
    <>
      <div className="propertyLabel">Investment&nbsp;Performance</div>
      <div className="property performanceBenchmark">
        <div className="performanceWindowPicker">
          {WINDOW_OPTIONS.map((opt) => (
            <button
              key={opt}
              type="button"
              className={opt === windowKey ? "active" : ""}
              onClick={() => setWindowKey(opt)}
            >
              {opt}
            </button>
          ))}
        </div>

        <div className="performanceRow">
          <span className="performanceLabel">Your asset return (MWR)</span>
          <span
            className="performanceValues clickable"
            onClick={toggleDisplayMode}
            role="button"
            tabIndex={0}
            onKeyDown={handleToggleKey}
          >
            {displayMode === "pct"
              ? renderValues(mwr.cumulative, mwr.annualized, "—", formatPct)
              : renderValues(mwrGain, perYear(mwrGain), "—", formatSignedDollars)}
          </span>
        </div>

        <div className="performanceRow">
          <span className="performanceLabel">{BENCHMARK_TICKER} benchmark</span>
          <span
            className="performanceValues clickable"
            onClick={toggleDisplayMode}
            role="button"
            tabIndex={0}
            onKeyDown={handleToggleKey}
          >
            {displayMode === "pct"
              ? benchmark
                ? renderValues(benchmark.cumulative, benchmark.annualized, "—", formatPct)
                : <span className="no-data">{vooHistory ? "no price data" : "loading…"}</span>
              : renderValues(
                  benchmarkGain,
                  perYear(benchmarkGain),
                  vooHistory ? "no price data" : "loading…",
                  formatSignedDollars,
                )}
          </span>
        </div>

        {(gapPct !== null || gapDollars !== null) && (
          <div
            className="performanceRow gap"
            title="Difference between your portfolio and the same money invested in the benchmark. Click to toggle % ↔ $"
          >
            <span className="performanceLabel">Diff</span>
            <span
              className="performanceValues clickable"
              onClick={toggleDisplayMode}
              role="button"
              tabIndex={0}
              onKeyDown={handleToggleKey}
            >
              {displayMode === "pct"
                ? renderValues(gapPct, gapPctAnnualized, "—", formatPct, gapPct)
                : renderValues(
                    gapDollars,
                    perYear(gapDollars),
                    "—",
                    formatSignedDollars,
                    gapDollars,
                  )}
            </span>
          </div>
        )}

        <div className="performanceFootnote">
          Showing {windowStart} → {windowEnd} · asset positions only (cash excluded)
          {isClamped && " · clamped to earliest data"}
          {suppressAnnualized && " · annualized hidden (window <6mo)"}
        </div>
      </div>
    </>
  );
};
