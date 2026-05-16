import { useMemo, useState } from "react";
import { Account, useAppContext } from "client";
import {
  extractCashFlows,
  computeMWR,
  computeBenchmarkTWR,
  valueAt,
  buildPriceAt,
  findBenchmarkSecurityId,
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
  const { data } = useAppContext();
  const { investmentTransactions, holdingSnapshots, securitySnapshots } = data;

  const [windowKey, setWindowKey] = useState<WindowKey>("1Y");

  const computed = useMemo(() => {
    // Find the earliest holding snapshot for this account — that's the
    // best `window_start` candidate ("All" window) since values before
    // then are zero from the FE's perspective. For 1Y/3Y windows, clamp
    // to today − N years, but never earlier than the earliest snapshot.
    let earliest: string | null = null;
    holdingSnapshots.forEach((s) => {
      if (s.holding.account_id !== account_id) return;
      const d = s.snapshot.date.slice(0, 10);
      if (!earliest || d < earliest) earliest = d;
    });
    if (!earliest) return null;

    const today = new Date();
    const windowEnd = toDateString(today);
    const clamp = (target: Date): string => {
      const t = toDateString(target);
      return t < earliest! ? earliest! : t;
    };

    let windowStart: string;
    if (windowKey === "All") {
      windowStart = earliest;
    } else {
      const years = windowKey === "1Y" ? 1 : 3;
      const target = new Date(today);
      target.setFullYear(target.getFullYear() - years);
      windowStart = clamp(target);
    }

    const priceAt = buildPriceAt(securitySnapshots);
    const vStart = valueAt({ date: windowStart, accountId: account_id, holdingSnapshots, priceAt });
    const vEnd = valueAt({ date: windowEnd, accountId: account_id, holdingSnapshots, priceAt });

    const allFlows = extractCashFlows(investmentTransactions, holdingSnapshots, account_id);
    const flows = allFlows.filter((f) => f.date > windowStart && f.date <= windowEnd);

    const mwr = computeMWR({ flows, vStart, vEnd, windowStart, windowEnd });

    const benchmarkSecId = findBenchmarkSecurityId(securitySnapshots, BENCHMARK_TICKER);
    let benchmark: ReturnType<typeof computeBenchmarkTWR> | null = null;
    if (benchmarkSecId) {
      const priceStart = priceAt(benchmarkSecId, windowStart);
      const priceEnd = priceAt(benchmarkSecId, windowEnd);
      if (priceStart && priceEnd) {
        benchmark = computeBenchmarkTWR({ priceStart, priceEnd, windowStart, windowEnd });
      }
    }

    const yearsInWindow =
      (new Date(windowEnd).getTime() - new Date(windowStart).getTime()) / (1000 * 60 * 60 * 24 * 365);
    const suppressAnnualized = yearsInWindow < 0.5;

    const gap =
      mwr.annualized !== null && benchmark
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
      gap,
      suppressAnnualized,
    };
  }, [account_id, investmentTransactions, holdingSnapshots, securitySnapshots, windowKey]);

  if (!computed) return null;
  const { windowStart, windowEnd, mwr, benchmark, benchmarkAvailable, gap, suppressAnnualized } = computed;

  return (
    <>
      <div className="propertyLabel">Performance</div>
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
          <span className="performanceLabel">Your return (MWR)</span>
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
          <span className="performanceLabel">{BENCHMARK_TICKER} benchmark</span>
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
                {benchmarkAvailable ? "no price data" : `no ${BENCHMARK_TICKER} in this account`}
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
          Showing {windowStart} → {windowEnd}
          {suppressAnnualized && " · annualized hidden (window <6mo)"}
        </div>
      </div>
    </>
  );
};
