import { useMemo, useState } from "react";
import { Account, useAppContext } from "client";
import {
  extractCashFlows,
  computeMWR,
  computeBenchmarkTWR,
  valueAt,
  buildPriceAt,
  findBenchmarkSecurityId,
  firstPricedSnapshotDate,
  earliestDataDate,
} from "client/lib/hooks/calculation/benchmark";
import "./index.css";

interface Props {
  account: Account;
}

type WindowKey = "1Y" | "3Y" | "All";
const WINDOW_OPTIONS: WindowKey[] = ["1Y", "3Y", "All"];
const BENCHMARK_TICKER = "VOO";

const toDateString = (d: Date) => d.toISOString().slice(0, 10);

const formatPct = (n: number | null): string => {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
};

export const PerformanceBenchmark = ({ account }: Props) => {
  const { account_id } = account;
  const { data, viewDate } = useAppContext();
  const { investmentTransactions, holdingSnapshots, securitySnapshots } = data;

  const [windowKey, setWindowKey] = useState<WindowKey>("1Y");

  const computed = useMemo(() => {
    // "Earliest available data" is now `min(first_holding_snapshot, first_txn)`
    // for the account. Accounts whose txn history predates the snapshot
    // history can show a longer "All" window via the txn-derived qty walk
    // in valueAt.
    const earliest = earliestDataDate({
      accountId: account_id,
      holdingSnapshots,
      investmentTransactions,
    });
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

    // Guard: if windowEnd somehow ends up ≤ windowStart (e.g. viewDate
    // is before the earliest snapshot), don't try to compute.
    if (windowEnd <= windowStart) return null;

    const priceAt = buildPriceAt(securitySnapshots);
    const vStart = valueAt({
      date: windowStart,
      windowStart,
      accountId: account_id,
      holdingSnapshots,
      investmentTransactions,
      priceAt,
    });
    const vEnd = valueAt({
      date: windowEnd,
      windowStart,
      accountId: account_id,
      holdingSnapshots,
      investmentTransactions,
      priceAt,
    });

    const allFlows = extractCashFlows(investmentTransactions, holdingSnapshots, account_id);
    const flows = allFlows.filter((f) => f.date > windowStart && f.date <= windowEnd);

    const mwr = computeMWR({ flows, vStart, vEnd, windowStart, windowEnd });

    // Benchmark: prefer strict prices over the user's full window, but if
    // the user-chosen window predates our VOO snapshot history, narrow the
    // benchmark window to [first_VOO_snap, windowEnd] so the user still
    // sees a real comparison number — clearly labeled with the actual
    // benchmark start date. Hide the gap row when the windows differ since
    // MWR-over-3Y vs. TWR-over-11mo isn't apples-to-apples.
    const benchmarkSecId = findBenchmarkSecurityId(securitySnapshots, BENCHMARK_TICKER);
    let benchmark: ReturnType<typeof computeBenchmarkTWR> | null = null;
    let benchmarkStart: string | null = null;
    let benchmarkNarrowed = false;
    if (benchmarkSecId) {
      const firstSnap = firstPricedSnapshotDate(securitySnapshots, benchmarkSecId);
      const effectiveStart =
        firstSnap && firstSnap > windowStart ? firstSnap : windowStart;
      benchmarkNarrowed = effectiveStart !== windowStart;
      const priceStart = priceAt(benchmarkSecId, effectiveStart, { strict: true });
      const priceEnd = priceAt(benchmarkSecId, windowEnd, { strict: true });
      if (priceStart && priceEnd && effectiveStart < windowEnd) {
        benchmark = computeBenchmarkTWR({
          priceStart,
          priceEnd,
          windowStart: effectiveStart,
          windowEnd,
        });
        benchmarkStart = effectiveStart;
      }
    }

    const yearsInWindow =
      (new Date(windowEnd).getTime() - new Date(windowStart).getTime()) / (1000 * 60 * 60 * 24 * 365);
    const suppressAnnualized = yearsInWindow < 0.5;

    // Only compare annualized rates when both legs cover the same window.
    // Otherwise gap is mixing a long-window MWR with a short-window TWR.
    const gap =
      mwr.annualized !== null && benchmark && !benchmarkNarrowed
        ? mwr.annualized - benchmark.annualized
        : null;

    return {
      windowStart,
      windowEnd,
      vStart,
      vEnd,
      flowCount: flows.length,
      mwr,
      benchmark,
      benchmarkAvailable: benchmarkSecId !== null,
      benchmarkStart,
      benchmarkNarrowed,
      gap,
      suppressAnnualized,
      isClamped,
    };
  }, [account_id, investmentTransactions, holdingSnapshots, securitySnapshots, windowKey, viewDate]);

  if (!computed) return null;
  const {
    windowStart,
    windowEnd,
    mwr,
    benchmark,
    benchmarkAvailable,
    benchmarkStart,
    benchmarkNarrowed,
    gap,
    suppressAnnualized,
    isClamped,
  } = computed;

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
          <span className="performanceValues">
            {mwr.status === "ok" ? (
              <>
                <span className="cum">{formatPct(mwr.cumulative)}</span>
                {!suppressAnnualized && (
                  <span className="ann">{formatPct(mwr.annualized)}/yr</span>
                )}
              </>
            ) : (
              <span className="no-data">—</span>
            )}
          </span>
        </div>

        <div className="performanceRow">
          <span className="performanceLabel">
            {BENCHMARK_TICKER} benchmark
            {benchmarkNarrowed && benchmarkStart && (
              <span className="performanceLabelHint"> (since {benchmarkStart})</span>
            )}
          </span>
          <span className="performanceValues">
            {benchmark ? (
              <>
                <span className="cum">{formatPct(benchmark.cumulative)}</span>
                {!suppressAnnualized && (
                  <span className="ann">{formatPct(benchmark.annualized)}/yr</span>
                )}
              </>
            ) : (
              <span className="no-data">
                {benchmarkAvailable
                  ? "no price data"
                  : `no ${BENCHMARK_TICKER} in this account`}
              </span>
            )}
          </span>
        </div>

        {gap !== null && !suppressAnnualized && (
          <div className="performanceRow gap">
            <span className="performanceLabel">vs benchmark</span>
            <span className={`performanceValues ${gap >= 0 ? "positive" : "negative"}`}>
              <span className="ann">{formatPct(gap)}/yr</span>
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
