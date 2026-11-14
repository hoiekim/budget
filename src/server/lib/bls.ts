/**
 * Bureau of Labor Statistics public data API — used for Consumer Price Index
 * history behind the projection chart's auto inflation rate.
 * https://www.bls.gov/developers/api_signature_v2.htm
 *
 * Only the scheduled refresh (`compute-tools/refresh-cpi-snapshots.ts`) calls
 * this module. Client requests read the stored rows and never reach BLS.
 */

import { ONE_DAY, Queue, QueueWaitTimeoutError } from "common";
import { logger } from "./logger";

const BLS_HOST = "https://api.bls.gov";

/** CPI-U, U.S. city average, all items, not seasonally adjusted (1982-84 = 100). */
export const CPI_SERIES_ID = "CUUR0000SA0";

// Read at call time so tests can toggle it without reloading the module.
const getApiKey = () => process.env.BLS_API_KEY;

export interface BlsTier {
  version: "v1" | "v2";
  /** The daily request cap BLS enforces for this tier. */
  dailyLimit: number;
  /** How many requests this process lets itself make per rolling 24 hours. */
  dailyBudget: number;
  /** The widest `startyear..endyear` span one request may ask for. */
  maxYearsPerRequest: number;
}

/**
 * BLS publishes two tiers. Without a registration key the v1 endpoint allows
 * 25 requests a day at 10 years each; with one, v2 allows 500 a day at 20
 * years each. `dailyBudget` is this process's share, counted in memory: a
 * restart starts a fresh count, and BLS's cap is per key or IP, shared with
 * anything else using it.
 */
export const getBlsTier = (): BlsTier =>
  getApiKey()
    ? { version: "v2", dailyLimit: 500, dailyBudget: 50, maxYearsPerRequest: 20 }
    : { version: "v1", dailyLimit: 25, dailyBudget: 10, maxYearsPerRequest: 10 };

const makeBudgetQueue = () =>
  new Queue({ capacity: () => getBlsTier().dailyBudget, windowMs: ONE_DAY });

let budgetQueue = makeBudgetQueue();

/** Forget every request counted against the daily budget (tests only). */
export const resetBlsRequestBudget = () => {
  budgetQueue = makeBudgetQueue();
};

export interface CpiObservation {
  year: number;
  /** 1-12 */
  month: number;
  value: number;
}

export type BlsResult<T> =
  | { success: true; data: T }
  | {
      success: false;
      error: "api_error" | "no_data" | "rate_limited" | "budget_exhausted";
      message: string;
    };

interface BlsResponseBody {
  status?: string;
  message?: unknown;
  Results?: {
    series?: Array<{
      seriesID?: string;
      data?: Array<{ year?: string; period?: string; value?: string }>;
    }>;
  };
}

/** `M01`..`M12`. `M13` is the annual average and is not a month. */
const MONTHLY_PERIOD = /^M(0[1-9]|1[0-2])$/;

const messagesOf = (message: unknown): string =>
  Array.isArray(message) ? message.filter((m) => typeof m === "string").join("; ") : "";

/**
 * BLS answers a refused request with HTTP 200 and a status other than
 * `REQUEST_SUCCEEDED`. Running past the daily cap reads "…daily threshold…",
 * which is worth telling apart: the caller should stop for the day rather
 * than count it as one more failure to retry next hour.
 */
const refusal = (body: BlsResponseBody): BlsResult<never> | undefined => {
  if (body.status === "REQUEST_SUCCEEDED") return undefined;
  const message = messagesOf(body.message) || `BLS request status ${String(body.status)}`;
  const error = /threshold/i.test(message) ? "rate_limited" : "api_error";
  return { success: false, error, message };
};

/**
 * Parse one series' observations. Months BLS could not publish carry a
 * non-numeric value (October 2025 reads `-`: the index was not collected
 * during that year's lapse in appropriations), so they are dropped rather
 * than stored as zero.
 */
export const parseCpiObservations = (body: BlsResponseBody): CpiObservation[] => {
  const data = body.Results?.series?.[0]?.data ?? [];
  const observations: CpiObservation[] = [];
  for (const row of data) {
    const period = row.period ?? "";
    if (!MONTHLY_PERIOD.test(period)) continue;
    const year = Number(row.year);
    const value = Number(row.value);
    if (!Number.isInteger(year) || !Number.isFinite(value) || value <= 0) continue;
    observations.push({ year, month: Number(period.slice(1)), value });
  }
  return observations.sort((a, b) => a.year - b.year || a.month - b.month);
};

/**
 * Fetch one series between two calendar years, inclusive, in a single request.
 * Callers split longer spans with `getBlsTier().maxYearsPerRequest`; a span
 * wider than that is rejected up front instead of spending a request BLS
 * would refuse.
 */
export const getCpiSeries = async (
  startYear: number,
  endYear: number,
  seriesId: string = CPI_SERIES_ID,
): Promise<BlsResult<CpiObservation[]>> => {
  const tier = getBlsTier();
  const span = endYear - startYear + 1;
  if (span < 1 || span > tier.maxYearsPerRequest) {
    return {
      success: false,
      error: "api_error",
      message: `BLS ${tier.version} accepts 1-${tier.maxYearsPerRequest} years per request, asked for ${span}`,
    };
  }

  const apiKey = getApiKey();
  const url = `${BLS_HOST}/publicAPI/${tier.version}/timeseries/data/`;
  const body: Record<string, unknown> = {
    seriesid: [seriesId],
    startyear: String(startYear),
    endyear: String(endYear),
  };
  if (apiKey) body.registrationkey = apiKey;

  try {
    const response = await budgetQueue.add(
      () =>
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      // Fail fast on a spent budget: 0 would wait forever for a slot hours away.
      { maxWaitMs: 1 },
    );
    if (!response.ok) {
      return { success: false, error: "api_error", message: `BLS HTTP ${response.status}` };
    }
    const json = (await response.json()) as BlsResponseBody;
    const refused = refusal(json);
    if (refused) return refused;

    const observations = parseCpiObservations(json);
    if (!observations.length) {
      return {
        success: false,
        error: "no_data",
        message: `No ${seriesId} data for ${startYear}-${endYear}`,
      };
    }
    return { success: true, data: observations };
  } catch (err) {
    if (err instanceof QueueWaitTimeoutError) {
      return {
        success: false,
        error: "budget_exhausted",
        message: `BLS daily request budget (${tier.dailyBudget}) is spent`,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`BLS API error for ${seriesId}: ${message}`, { component: "bls" });
    return { success: false, error: "api_error", message };
  }
};
