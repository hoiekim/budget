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
  SNAPSHOT_DATE,
  SNAPSHOT_TYPE,
} from "server";

export interface RefreshSecuritySnapshotsResult {
  /** Securities for which a fresh snapshot was written this run. */
  refreshed: number;
  /** Securities where a snapshot for the latest trading day already existed. */
  fresh: number;
  /** Securities skipped because they are cash-equivalents. */
  cash: number;
  /** Polygon returned `no_data` (untracked / delisted / out-of-plan window). */
  empty: number;
  /** Polygon API or upsert errors. */
  errors: number;
}

/**
 * For every security currently referenced by a non-deleted holding row,
 * ensure a `security_snapshot` exists for the latest trading day that
 * polygon can serve. Designed to ride the existing hourly `scheduledSync`
 * loop — per-security cadence is enforced by the existence check on the
 * latest trading day's snapshot, so subsequent hourly runs early-out
 * with one cheap SELECT per security.
 *
 * Plaid-tracked securities go through `upsertSecuritiesWithSnapshots`
 * during sync, which already writes a `getSquashedDateString()`-keyed
 * snapshot — those rows surface here too but are early-outed by the
 * per-trading-day check.
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

    // Ask polygon for the latest trading day's close at or before today.
    // The returned `tradingDate` is the actual market day the price is
    // anchored to — naturally falls back to Friday on weekends, the day
    // before a holiday, etc. Writing the snapshot under `tradingDate`
    // means subsequent same-day runs early-out via the existence check
    // below; once a new trading day closes, the next run picks it up.
    const fetchResult = await polygon.getLatestClosePriceOnOrBefore(ticker_symbol, today);
    if (!fetchResult.success) {
      if (fetchResult.error === "no_data") result.empty++;
      else result.errors++;
      continue;
    }
    const { price, tradingDate } = fetchResult.data;

    // Existence check on the polygon-returned tradingDate, not today's
    // date — see comment above for why.
    const existing = await pool.query<{ snapshot_id: string }>(
      `SELECT snapshot_id FROM ${SNAPSHOTS}
       WHERE ${SECURITY_ID} = $1
         AND ${SNAPSHOT_TYPE} = 'security'
         AND ${SNAPSHOT_DATE} = $2::date
         AND (is_deleted IS NULL OR is_deleted = FALSE)
       LIMIT 1`,
      [security_id, tradingDate],
    );
    if (existing.rows.length > 0) {
      result.fresh++;
      continue;
    }

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
