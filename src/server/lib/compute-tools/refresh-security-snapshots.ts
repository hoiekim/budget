import { getDateString, getSquashedDateString, JSONSecurity, JSONSecuritySnapshot } from "common";
import {
  pool,
  upsertSnapshots,
  upsertSecurities,
  searchSecurities,
  searchSecuritiesById,
  marketData,
  logger,
  SECURITY_ID,
  SNAPSHOT_TYPE,
  UPDATED,
} from "server";
import {
  BENCHMARK_TICKER,
  HOLDINGS,
  SNAPSHOTS,
} from "common/constants";


export interface RefreshSecuritySnapshotsResult {
  /** Securities for which a fresh snapshot was written this run. */
  refreshed: number;
  /** Securities skipped because a non-stale snapshot already exists. */
  fresh: number;
  /** Securities skipped because they are cash-equivalents. */
  cash: number;
  /** Polygon returned `no_data` (untracked / delisted / out-of-plan window). */
  empty: number;
  /** Polygon API or upsert errors. */
  errors: number;
}

/**
 * Skip-window for the per-security cadence gate. If any security_snapshot
 * for a given security has been written or updated within this window,
 * the polygon refresh is skipped this cycle. The window is wider than
 * the hourly cron cadence so most cycles skip without burning an API
 * call, but narrow enough that a missed mid-day update only delays a
 * fresh price by ~one day.
 */
const REFRESH_SKIP_WINDOW_HOURS = 22;

/** The id of the benchmark's security row when no provider has written one. */
export const BENCHMARK_SECURITY_ID = `benchmark-${BENCHMARK_TICKER}`;

const isCash = (security: Pick<JSONSecurity, "ticker_symbol" | "type">) =>
  security.type === "cash" || !!security.ticker_symbol?.startsWith("CUR:");

/**
 * The benchmark's security row: the latest one with its ticker, or one
 * written for it when there is none, so its prices sync to every user
 * whether or not anyone holds it.
 */
const getBenchmarkSecurityId = async (): Promise<string | null> => {
  const existing = (await searchSecurities({ ticker_symbol: BENCHMARK_TICKER })).find((s) => !isCash(s));
  if (existing) return existing.security_id;
  const [written] = await upsertSecurities([
    {
      security_id: BENCHMARK_SECURITY_ID,
      ticker_symbol: BENCHMARK_TICKER,
      name: "Vanguard S&P 500 ETF",
      iso_currency_code: "USD",
      type: "etf",
      close_price: null,
      close_price_as_of: null,
      isin: null,
      cusip: null,
      sedol: null,
      institution_security_id: null,
      institution_id: null,
      proxy_security_id: null,
      is_cash_equivalent: null,
      update_datetime: null,
      unofficial_currency_code: null,
      market_identifier_code: null,
      sector: null,
      industry: null,
      option_contract: null,
      fixed_income: null,
    },
  ]);
  return written && written.status < 400 ? BENCHMARK_SECURITY_ID : null;
};

/**
 * For every security currently referenced by a non-deleted holding row,
 * and for the benchmark (`BENCHMARK_TICKER`), ensure a `security_snapshot`
 * exists for the latest trading day that polygon can serve. Designed to
 * ride the existing hourly `scheduledSync` loop.
 *
 * Per-security cadence is enforced by a cheap pre-flight SELECT against
 * `snapshots.updated` — if any security_snapshot for this security was
 * touched within the last `REFRESH_SKIP_WINDOW_HOURS`, the polygon call
 * is skipped. This keeps steady-state runs at one cheap SELECT per
 * security (no polygon calls) and bounds the polygon load to roughly
 * one call per security per day in the limit.
 *
 * Provider-synced securities go through `upsertSecuritiesWithSnapshots`
 * during sync, which writes a snapshot with `updated = CURRENT_TIMESTAMP`
 * (Plaid's dated by `close_price_as_of`, in this job's id format) — those
 * rows are early-outed here by the same cadence gate.
 *
 * Cash-equivalents (`type='cash'` or `ticker_symbol` starting with
 * `CUR:`) are skipped — polygon does not price them.
 */
export const refreshActiveSecuritySnapshots = async (): Promise<RefreshSecuritySnapshotsResult> => {
  const result: RefreshSecuritySnapshotsResult = {
    refreshed: 0,
    fresh: 0,
    cash: 0,
    empty: 0,
    errors: 0,
  };

  const rows = await pool.query<{ security_id: string }>(
    `SELECT DISTINCT ${SECURITY_ID}
     FROM ${HOLDINGS}
     WHERE (is_deleted IS NULL OR is_deleted = FALSE)
       AND ${SECURITY_ID} IS NOT NULL`,
  );
  const benchmark = await getBenchmarkSecurityId();
  const security_ids = [...new Set([...rows.rows.map((r) => r.security_id), benchmark])].filter(
    (id): id is string => !!id,
  );
  if (security_ids.length === 0) return result;

  const securities = await searchSecuritiesById(security_ids);
  const today = new Date();

  for (const security of securities) {
    const { security_id, ticker_symbol, type } = security;
    if (!ticker_symbol) continue;
    if (isCash(security)) {
      result.cash++;
      continue;
    }

    // Pre-flight cadence gate. If any security_snapshot for this
    // security was touched in the last `REFRESH_SKIP_WINDOW_HOURS`,
    // skip the polygon call. Cheap SELECT, no API spend. The gate
    // also rate-limits the "soft-deleted snapshot" loop — a
    // soft-delete sets `updated` to NOW(), so the gate skips it until
    // the window expires.
    const recent = await pool.query<{ snapshot_id: string }>(
      `SELECT snapshot_id FROM ${SNAPSHOTS}
       WHERE ${SECURITY_ID} = $1
         AND ${SNAPSHOT_TYPE} = 'security'
         AND ${UPDATED} > NOW() - INTERVAL '${REFRESH_SKIP_WINDOW_HOURS} hours'
       LIMIT 1`,
      [security_id],
    );
    if (recent.rows.length > 0) {
      result.fresh++;
      continue;
    }

    // Cache miss → ask polygon for the latest trading day's close at
    // or before today. The returned `tradingDate` is the actual market
    // day the price is anchored to — naturally falls back to Friday on
    // weekends, the day before a holiday, etc.
    const fetchResult = await marketData.getLatestClosePriceOnOrBeforeWithFallback(ticker_symbol, today, {
      securityType: type,
    });
    if (!fetchResult.success) {
      if (fetchResult.error === "no_data") result.empty++;
      else result.errors++;
      continue;
    }
    const { price, tradingDate } = fetchResult.data;

    const tradingDateObj = new Date(`${tradingDate}T12:00:00Z`);
    const snapshot: JSONSecuritySnapshot = {
      snapshot: {
        snapshot_id: `${security_id}-${getSquashedDateString(tradingDateObj)}`,
        date: tradingDateObj.toISOString(),
      },
      security: {
        security_id,
        ticker_symbol,
        close_price: price,
        close_price_as_of: getDateString(tradingDateObj),
        // The rest of JSONSecurity is left null — the snapshot row only
        // carries security_id + close_price; the canonical securities row
        // is untouched.
        name: null,
        iso_currency_code: null,
        isin: null,
        cusip: null,
        sedol: null,
        institution_security_id: null,
        institution_id: null,
        proxy_security_id: null,
        is_cash_equivalent: null,
        type: null,
        update_datetime: null,
        unofficial_currency_code: null,
        market_identifier_code: null,
        sector: null,
        industry: null,
        option_contract: null,
        fixed_income: null,
      },
    };

    // `upsertSnapshots` catches per-snapshot errors internally and
    // returns one `UpsertResult { status }` per row instead of throwing.
    // A 4xx / 5xx status means the row didn't land.
    const [upsertResult] = await upsertSnapshots([snapshot]);
    if (!upsertResult || upsertResult.status >= 400) {
      logger.error("refreshActiveSecuritySnapshots: upsert failed", {
        security_id,
        tradingDate,
        status: upsertResult?.status,
      });
      result.errors++;
    } else {
      result.refreshed++;
    }
  }

  return result;
};
