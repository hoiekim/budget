import {
  getDateString,
  getSquashedDateString,
  getYearMonthString,
  JSONSecuritySnapshot,
} from "common";
import {
  getSecuritySnapshots as realGetSecuritySnapshots,
  searchSecuritiesById as realSearchSecuritiesById,
  upsertSnapshots as realUpsertSnapshots,
} from "server";
import { getClosePrice as realGetClosePrice } from "../polygon";
import { logger } from "../logger";

export interface BackfillSecurityRef {
  security_id: string;
  /** ISO date the security was first observed in a holding snapshot for this caller. */
  fromDate: string;
}

// DI seams — production callers pass nothing and get the real DB/polygon
// implementations. Tests pass mocks via positional args instead of
// `mock.module`, which is process-wide in Bun and leaks across sibling
// test files. Same factoring as `cash-holding.ts` (Hoie 2026-05-14).
type GetSecuritySnapshotsFn = typeof realGetSecuritySnapshots;
type SearchSecuritiesByIdFn = typeof realSearchSecuritiesById;
type UpsertSnapshotsFn = typeof realUpsertSnapshots;
type GetClosePriceFn = typeof realGetClosePrice;

export interface BackfillResult {
  /** Number of months newly filled with a security snapshot. */
  filled: number;
  /** Number of months skipped because a snapshot already existed. */
  skipped: number;
  /** Number of polygon calls that returned no data (delisted, holiday, etc.). */
  empty: number;
  /** Number of polygon API errors encountered. */
  errors: number;
}

const MAX_MONTHS_PER_INVOCATION = 60;

/**
 * Ensure each (security, month) tuple between `fromDate` and today has a
 * security snapshot, filling missing months from polygon's close_price on
 * the 15th of that month (or nearest prior trading day — polygon returns
 * the bar for the closest trading day in the range).
 *
 * Forward-only by design (Hoie 2026-05-13): we never reach into months
 * before the caller's `fromDate`, even if the security has been around
 * longer in the user's portfolio. The 60-month per-invocation cap is a
 * sanity ceiling for accidental "5-year-old manual holding" inputs.
 *
 * Hard rate-limit: polygon calls are gated by the per-minute bucket in
 * `polygon.ts`. A backfill that needs 30 calls on a free-tier key takes
 * ~6 minutes; that's intentional — bursts would 429.
 *
 * Cash-type securities have ticker symbols like "CUR:USD" that polygon
 * doesn't price; callers should filter them out before calling, or accept
 * the polygon `no_data` count in the result.
 */
export const backfillMonthlySecuritySnapshotsForward = async (
  refs: BackfillSecurityRef[],
  options: {
    maxMonthsPerInvocation?: number;
    searchSecuritiesById?: SearchSecuritiesByIdFn;
    getSecuritySnapshots?: GetSecuritySnapshotsFn;
    upsertSnapshots?: UpsertSnapshotsFn;
    getClosePrice?: GetClosePriceFn;
  } = {},
): Promise<BackfillResult> => {
  const cap = options.maxMonthsPerInvocation ?? MAX_MONTHS_PER_INVOCATION;
  // Resolve DI seams to the real implementations by default.
  const searchSecuritiesById = options.searchSecuritiesById ?? realSearchSecuritiesById;
  const getSecuritySnapshots = options.getSecuritySnapshots ?? realGetSecuritySnapshots;
  const upsertSnapshots = options.upsertSnapshots ?? realUpsertSnapshots;
  const getClosePrice = options.getClosePrice ?? realGetClosePrice;

  const result: BackfillResult = { filled: 0, skipped: 0, empty: 0, errors: 0 };

  if (refs.length === 0) return result;

  // Batch-resolve ticker + type from the securities table so callers only
  // need to pass security_ids. Filter out cash-equivalents (`type='cash'`,
  // tickers like `CUR:USD`) — polygon doesn't price them and a backfill
  // call would just burn a token to get `no_data`.
  const securities = await searchSecuritiesById(refs.map((r) => r.security_id));
  const securityMeta = new Map(
    securities.map((s) => [s.security_id, { ticker: s.ticker_symbol, type: s.type }]),
  );

  const nowYearMonth = getYearMonthString(new Date());

  for (const ref of refs) {
    const { security_id, fromDate } = ref;
    if (!security_id || !fromDate) continue;

    const meta = securityMeta.get(security_id);
    if (!meta) {
      logger.warn("backfill: no security row for ref", { security_id });
      continue;
    }
    if (!meta.ticker) {
      // No ticker — nothing to fetch from polygon.
      continue;
    }
    if (meta.type === "cash" || meta.ticker.startsWith("CUR:")) {
      // Cash-equivalent — polygon doesn't price these.
      continue;
    }
    const ticker_symbol = meta.ticker;

    let fromYearMonth: string;
    try {
      fromYearMonth = getYearMonthString(new Date(fromDate));
    } catch {
      logger.warn("backfill: skipping invalid fromDate", { security_id, fromDate });
      continue;
    }
    if (fromYearMonth > nowYearMonth) continue;

    // Existing snapshots for this security keyed by yearMonth.
    let existing: Awaited<ReturnType<typeof getSecuritySnapshots>>;
    try {
      existing = await getSecuritySnapshots({ security_id });
    } catch (err) {
      logger.error("backfill: failed to load existing security snapshots", { security_id }, err);
      result.errors++;
      continue;
    }
    const haveMonth = new Set(
      existing.map((s) => getYearMonthString(new Date(s.snapshot_date))),
    );

    const newSnapshots: JSONSecuritySnapshot[] = [];
    let monthsTouched = 0;

    for (
      let cursor = fromYearMonth;
      cursor <= nowYearMonth && monthsTouched < cap;
      cursor = nextYearMonth(cursor), monthsTouched++
    ) {
      if (haveMonth.has(cursor)) {
        result.skipped++;
        continue;
      }

      // Snapshot date = 15th for past months; previous day for the current
      // month. Today's market hasn't closed yet (Hoie 2026-05-15), so polygon
      // either returns no_data or the previous trading day's bar — either way
      // we should anchor the snapshot to "yesterday's close" rather than
      // labelling a future/in-progress price with today's date.
      const dayInMonth =
        cursor === nowYearMonth ? getDateString(getYesterday()) : `${cursor}-15`;
      const fetchResult = await getClosePrice(ticker_symbol, new Date(dayInMonth));

      if (!fetchResult.success) {
        if (fetchResult.error === "no_data") result.empty++;
        else result.errors++;
        // Don't break the loop — different months may have different outcomes
        // (e.g. delisted period vs. active period).
        continue;
      }

      newSnapshots.push({
        snapshot: {
          snapshot_id: `${security_id}-${getSquashedDateString(new Date(dayInMonth))}`,
          date: new Date(dayInMonth).toISOString(),
        },
        security: {
          security_id,
          ticker_symbol,
          close_price: fetchResult.data,
          close_price_as_of: dayInMonth,
          // The rest of JSONSecurity is unknown at backfill time; leave the
          // existing securities row untouched and only write the snapshot.
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
      });
      result.filled++;
    }

    if (newSnapshots.length > 0) {
      try {
        await upsertSnapshots(newSnapshots);
      } catch (err) {
        logger.error("backfill: upsert failed", { security_id, count: newSnapshots.length }, err);
        // Roll the filled count back so the caller's metric reflects what
        // actually landed in storage.
        result.filled -= newSnapshots.length;
        result.errors++;
      }
    }
  }

  return result;
};

const getYesterday = (): Date => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d;
};

/** Advance a YYYY-MM string by one month. */
const nextYearMonth = (ym: string): string => {
  const [yStr, mStr] = ym.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return ym;
  const nextMonth = m === 12 ? 1 : m + 1;
  const nextYear = m === 12 ? y + 1 : y;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}`;
};
