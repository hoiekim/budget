import { JSONCpiSnapshot } from "common";
import {
  bls,
  getCpiSnapshots,
  upsertCpiSnapshots,
  logger,
  INFLATION_AVERAGE_YEARS,
  toMonthIndex,
} from "server";

export interface RefreshCpiSnapshotsResult {
  /** BLS requests sent this run. */
  requests: number;
  /** CPI months written or re-stamped. */
  upserted: number;
  /** The stored series already reaches the newest month BLS could have published. */
  fresh: boolean;
  /** The series is behind, but a refresh ran within the skip window, so this run waits. */
  gated: boolean;
  /** Planned requests left for a later run: the daily budget (ours or BLS's) is spent, or BLS failed. */
  deferred: number;
  /** BLS errors, empty answers, and failed writes. */
  errors: number;
}

/**
 * Minimum spacing between refreshes of the newest months. CPI is monthly and
 * lands around mid-month, so while the next release is pending this keeps the
 * steady state to about one request a day — the same 22-hour window the
 * security-snapshot refresh uses, wide enough that most hourly runs make no
 * call at all.
 */
export const CPI_REFRESH_SKIP_WINDOW_HOURS = 22;

export interface CpiFetchPlan {
  /** Inclusive `[startYear, endYear]` spans, one BLS request each. */
  requests: Array<[number, number]>;
  fresh: boolean;
  gated: boolean;
}

/**
 * Decide which years to request, without touching the network.
 *
 * Backfill: every completed year inside the averaging window (plus one, so the
 * window's first month has a base to compare against) with no stored month at
 * all. An empty table therefore backfills the whole window in one run — 4
 * requests on the keyless tier, 2 with a key — and a backfill cut short by the
 * budget resumes from the years still missing. Years are tested for presence,
 * not completeness: BLS has gaps it will never fill (October 2025), and
 * re-requesting those would spend the budget forever.
 *
 * Refresh: the newest month BLS can have published is last month. When the
 * stored series stops short of it and nothing was written in the skip window,
 * re-request from the latest stored year through this year.
 *
 * Contiguous years are merged and then split at the tier's per-request cap.
 */
export const planCpiFetch = (
  snapshots: JSONCpiSnapshot[],
  now: Date,
  maxYearsPerRequest: number,
): CpiFetchPlan => {
  const currentYear = now.getFullYear();
  const firstYear = currentYear - INFLATION_AVERAGE_YEARS - 1;
  const years = new Set<number>();

  const storedYears = new Set(snapshots.map((s) => Number(s.date.slice(0, 4))));
  for (let year = firstYear; year < currentYear; year++) {
    if (!storedYears.has(year)) years.add(year);
  }

  let latestStored: number | undefined;
  let lastWrite = 0;
  for (const s of snapshots) {
    const index = toMonthIndex(s.date);
    if (latestStored === undefined || index > latestStored) latestStored = index;
    const updated = s.updated ? Date.parse(s.updated) : NaN;
    if (Number.isFinite(updated) && updated > lastWrite) lastWrite = updated;
  }

  const newestPublishable = currentYear * 12 + now.getMonth() - 1;
  const fresh = latestStored !== undefined && latestStored >= newestPublishable;
  const windowMs = CPI_REFRESH_SKIP_WINDOW_HOURS * 60 * 60 * 1000;
  const gated = !fresh && lastWrite > 0 && now.getTime() - lastWrite < windowMs;

  if (!fresh && !gated) {
    const from = latestStored === undefined ? currentYear : Math.floor(latestStored / 12);
    for (let year = Math.max(from, firstYear); year <= currentYear; year++) years.add(year);
  }

  const sorted = [...years].sort((a, b) => a - b);
  const requests: Array<[number, number]> = [];
  for (const year of sorted) {
    const last = requests[requests.length - 1];
    const extendsRun = last && last[1] === year - 1 && year - last[0] < maxYearsPerRequest;
    if (extendsRun) last[1] = year;
    else requests.push([year, year]);
  }

  return { requests, fresh, gated };
};

/**
 * Keep the stored CPI-U series current and backfilled, riding the hourly
 * `scheduledSync` loop the way `refreshActiveSecuritySnapshots` does.
 *
 * BLS is never called on a client request: `GET /api/inflation` reads what
 * this job stored. Request volume is bounded three ways. The planner only asks
 * for missing years and, at most once per skip window, for the newest months;
 * that gate lives in the table (`updated`), so it survives a restart. A failed
 * request ends the run, so while BLS is failing each run spends one request.
 * And every request draws on the per-process daily budget in `bls.ts`.
 */
export const refreshCpiSnapshots = async (now = new Date()): Promise<RefreshCpiSnapshotsResult> => {
  const series_id = bls.CPI_SERIES_ID;
  const tier = bls.getBlsTier();
  const snapshots = await getCpiSnapshots(series_id);
  const plan = planCpiFetch(snapshots, now, tier.maxYearsPerRequest);

  const result: RefreshCpiSnapshotsResult = {
    requests: 0,
    upserted: 0,
    fresh: plan.fresh,
    gated: plan.gated,
    deferred: 0,
    errors: 0,
  };

  const nowIndex = now.getFullYear() * 12 + now.getMonth();

  for (let i = 0; i < plan.requests.length; i++) {
    const [startYear, endYear] = plan.requests[i];
    const fetched = await bls.getCpiSeries(startYear, endYear, series_id);

    if (!fetched.success) {
      if (fetched.error !== "budget_exhausted") result.requests++;
      if (fetched.error === "budget_exhausted" || fetched.error === "rate_limited") {
        result.deferred += plan.requests.length - i;
        logger.warn("refreshCpiSnapshots: daily BLS budget reached, deferring", {
          startYear,
          endYear,
          message: fetched.message,
        });
        break;
      }
      result.errors++;
      logger.warn("refreshCpiSnapshots: BLS request failed", {
        startYear,
        endYear,
        error: fetched.error,
        message: fetched.message,
      });
      // An empty span says nothing about the next one; an API error likely repeats.
      if (fetched.error === "no_data") continue;
      result.deferred += plan.requests.length - i - 1;
      break;
    }
    result.requests++;

    const rows: JSONCpiSnapshot[] = fetched.data
      .filter((o) => o.year >= startYear && o.year <= endYear)
      .filter((o) => o.year * 12 + o.month - 1 <= nowIndex)
      .map((o) => ({
        series_id,
        date: `${o.year}-${String(o.month).padStart(2, "0")}-01`,
        value: o.value,
      }));

    try {
      result.upserted += await upsertCpiSnapshots(rows);
    } catch (error) {
      logger.error("refreshCpiSnapshots: upsert failed", { startYear, endYear }, error);
      result.errors++;
    }
  }

  return result;
};
