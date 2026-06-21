import { getDateString, getSquashedDateString, JSONSecuritySnapshot } from "common";
import {
  pool,
  upsertSnapshots,
  searchSecuritiesById,
  polygon,
  logger,
  HOLDINGS,
  SNAPSHOTS,
  SECURITY_ID,
  SNAPSHOT_TYPE,
  UPDATED,
} from "server";

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

/**
 * For every security currently referenced by a non-deleted holding row,
 * ensure a `security_snapshot` exists for the latest trading day that
 * polygon can serve. Designed to ride the existing hourly `scheduledSync`
 * loop.
 *
 * Per-security cadence is enforced by a cheap pre-flight SELECT against
 * `snapshots.updated` — if any security_snapshot for this security was
 * touched within the last `REFRESH_SKIP_WINDOW_HOURS`, the polygon call
 * is skipped. This keeps steady-state runs at one cheap SELECT per
 * security (no polygon calls) and bounds the polygon load to roughly
 * one call per security per day in the limit.
 *
 * Plaid-tracked securities go through `upsertSecuritiesWithSnapshots`
 * during sync, which writes a `getSquashedDateString()`-keyed snapshot
 * with `updated = CURRENT_TIMESTAMP` — those rows are early-outed here
 * by the same cadence gate.
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
  const security_ids = rows.rows.map((r) => r.security_id).filter(Boolean);
  if (security_ids.length === 0) return result;

  const securities = await searchSecuritiesById(security_ids);
  const today = new Date();

  for (const security of securities) {
    const { security_id, ticker_symbol, type } = security;
    if (!ticker_symbol) continue;
    if (type === "cash" || ticker_symbol.startsWith("CUR:")) {
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
    const fetchResult = await polygon.getLatestClosePriceOnOrBefore(ticker_symbol, today);
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
