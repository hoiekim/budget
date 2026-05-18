/**
 * We use polygon API to get stock price data, etc.
 * https://polygon.io/docs/stocks/getting-started
 */

import { getDateString, getDateTimeString, getRandomId, JSONSecurity, Queue } from "common";
import { logger } from "./logger";

const POLYGON_HOST = "https://api.polygon.io";

// Helper to get API key at runtime (for testability)
const getApiKey = () => process.env.POLYGON_API_KEY;

// Warn on startup if API key is missing
if (!getApiKey()) {
  logger.warn("POLYGON_API_KEY not set - stock price fetching will be disabled", {
    component: "polygon",
  });
}

// ---------------------------------------------------------------------------
// Rate-limit gate
// ---------------------------------------------------------------------------
// Polygon free tier caps at 5 calls/min. The monthly-backfill flow can fan
// out to dozens of calls per security on first-seen accounts, so every
// outbound polygon request goes through a shared `Queue` to avoid 429s and
// the noisy retry backoff that follows. Cache hits must NOT route through
// the queue (otherwise warm reads would consume a slot).
//
// `POLYGON_RATE_LIMIT_PER_MIN` (env, default 5) caps the queue. Setting it
// to 0 disables the gate entirely (useful for paid tiers / tests). The
// capacity is read on every `add()` so tests can flip it without rebooting
// the module.

const DEFAULT_RATE_LIMIT_PER_MIN = 5;

const getRateLimitPerMin = (): number => {
  const raw = process.env.POLYGON_RATE_LIMIT_PER_MIN;
  if (raw === undefined || raw === "") return DEFAULT_RATE_LIMIT_PER_MIN;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RATE_LIMIT_PER_MIN;
  return Math.floor(n);
};

export const polygonQueue = new Queue({ capacity: getRateLimitPerMin });

/**
 * Result types for Polygon API calls
 */
export type PolygonResult<T> =
  | { success: true; data: T }
  | {
      success: false;
      error: "no_api_key" | "api_error" | "no_data" | "plan_limit";
      message: string;
    };

/**
 * Simple in-memory cache for price data
 * Key format: `${ticker}:${dateString}`
 */
const priceCache = new Map<string, { price: number; fetchedAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Periodically evict stale price cache entries to prevent unbounded growth.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of priceCache) {
    if (now - entry.fetchedAt >= CACHE_TTL_MS) priceCache.delete(key);
  }
}, CACHE_TTL_MS).unref();

/**
 * Fetch with retry logic for transient failures
 */
const fetchWithRetry = async (url: string, maxRetries = 2, delayMs = 1000): Promise<Response> => {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 404) {
        // 404 is "no data", not a transient error
        return response;
      }
      // Retry on 5xx errors
      if (response.status >= 500) {
        lastError = new Error(`HTTP ${response.status}`);
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
          continue;
        }
      }
      return response;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
        continue;
      }
    }
  }

  throw lastError || new Error("Fetch failed");
};

export const getClosePrice = async (
  ticker_symbol: string,
  date: Date,
): Promise<PolygonResult<number>> => {
  if (!getApiKey()) {
    return {
      success: false,
      error: "no_api_key",
      message: "Polygon API key not configured",
    };
  }

  const dateString = getDateString(date);
  const cacheKey = `${ticker_symbol}:${dateString}`;

  // Check cache first
  const cached = priceCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { success: true, data: cached.price };
  }

  const from = dateString;
  const to = dateString;
  const tickerParameter = `ticker/${ticker_symbol}`;
  const rangeParameter = `range/1/day/${from}/${to}`;
  const path = `${POLYGON_HOST}/v2/aggs/${tickerParameter}/${rangeParameter}?apiKey=${getApiKey()}`;

  try {
    // Queue gate sits AFTER cache check so warm reads don't consume a slot.
    const response = await polygonQueue.add(() => fetchWithRetry(path));
    const json = await response.json();

    if (!json.results || json.results.length === 0) {
      return {
        success: false,
        error: "no_data",
        message: `No price data available for ${ticker_symbol} on ${dateString}`,
      };
    }

    const price = json.results[0].c as number;

    // Cache successful result
    priceCache.set(cacheKey, { price, fetchedAt: Date.now() });

    return { success: true, data: price };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Polygon API error for ${ticker_symbol}: ${message}`, { component: "polygon" });
    return {
      success: false,
      error: "api_error",
      message: `Failed to fetch price for ${ticker_symbol}: ${message}`,
    };
  }
};

export const getTickerDetail = async (
  ticker_symbol: string,
): Promise<PolygonResult<{ ticker_symbol: string; name: string; currency_name: string }>> => {
  if (!getApiKey()) {
    return {
      success: false,
      error: "no_api_key",
      message: "Polygon API key not configured",
    };
  }

  const path = `${POLYGON_HOST}/v3/reference/tickers/${ticker_symbol}?apiKey=${getApiKey()}`;

  try {
    // Same queue as getClosePrice — a backfill pass that uses both endpoints
    // stays under the per-minute cap across both methods.
    const response = await polygonQueue.add(() => fetchWithRetry(path));
    const json = await response.json();

    if (!json.results) {
      return {
        success: false,
        error: "no_data",
        message: `No ticker details found for ${ticker_symbol}`,
      };
    }

    const name = json.results.name as string;
    const currency_name = json.results.currency_name as string;

    return { success: true, data: { ticker_symbol, name, currency_name } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Polygon API error for ticker detail ${ticker_symbol}: ${message}`, {
      component: "polygon",
    });
    return {
      success: false,
      error: "api_error",
      message: `Failed to fetch ticker details for ${ticker_symbol}: ${message}`,
    };
  }
};

/**
 * Resolve the closest trading-day close price at or before `date`. Walks
 * Polygon's daily aggregates over a 7-day window ending at `date` and
 * returns the latest entry — that's the actual trading-day price for
 * non-trading-day inputs (weekends, holidays). Used by the benchmark
 * snapshot resolver so a window-start like "2023-05-13 (Saturday)"
 * resolves to Friday's close instead of returning `no_data`.
 */
export const getLatestClosePriceOnOrBefore = async (
  ticker_symbol: string,
  dateOrString: Date | string,
  lookbackDays = 7,
): Promise<PolygonResult<{ price: number; tradingDate: string }>> => {
  if (!getApiKey()) {
    return { success: false, error: "no_api_key", message: "Polygon API key not configured" };
  }

  // Compute `to` and `from` as YYYY-MM-DD purely from the string, avoiding
  // local-timezone shifts. (PST's `getDate()` on a UTC-midnight Date is one
  // day behind, which silently turns a 2025-05-17 lookup into 2025-05-16.)
  const to =
    typeof dateOrString === "string"
      ? dateOrString.slice(0, 10)
      : getDateString(dateOrString);
  const toAnchor = new Date(`${to}T12:00:00Z`);
  toAnchor.setUTCDate(toAnchor.getUTCDate() - lookbackDays);
  const from = toAnchor.toISOString().slice(0, 10);

  const path = `${POLYGON_HOST}/v2/aggs/ticker/${ticker_symbol}/range/1/day/${from}/${to}?apiKey=${getApiKey()}`;

  try {
    const response = await polygonQueue.add(() => fetchWithRetry(path));
    const json = await response.json();
    if (json.status === "NOT_AUTHORIZED") {
      return {
        success: false,
        error: "plan_limit",
        message:
          typeof json.message === "string"
            ? json.message
            : `Polygon plan does not include data for ${ticker_symbol} in [${from}, ${to}]`,
      };
    }
    const results = json.results as Array<{ c: number; t: number }> | undefined;
    if (!results || results.length === 0) {
      return {
        success: false,
        error: "no_data",
        message: `No price data for ${ticker_symbol} in [${from}, ${to}]`,
      };
    }
    const last = results[results.length - 1];
    const td = new Date(last.t);
    const tradingDate = `${td.getUTCFullYear()}-${String(td.getUTCMonth() + 1).padStart(2, "0")}-${String(td.getUTCDate()).padStart(2, "0")}`;
    return { success: true, data: { price: last.c, tradingDate } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Polygon range fetch error for ${ticker_symbol}: ${message}`, {
      component: "polygon",
    });
    return { success: false, error: "api_error", message };
  }
};

export const getSecurityForSymbol = async (
  ticker_symbol: string,
  date = new Date(Date.now() - 24 * 60 * 60 * 1000),
): Promise<JSONSecurity | undefined> => {
  const [priceResult, detailResult] = await Promise.all([
    getClosePrice(ticker_symbol, date),
    getTickerDetail(ticker_symbol),
  ]);

  // Log errors but return undefined for backward compatibility
  if (!priceResult.success) {
    logger.warn(`getSecurityForSymbol: ${priceResult.message}`, { component: "polygon" });
    return undefined;
  }
  if (!detailResult.success) {
    logger.warn(`getSecurityForSymbol: ${detailResult.message}`, { component: "polygon" });
    return undefined;
  }

  const { name, currency_name } = detailResult.data;

  return {
    security_id: getRandomId(),
    ticker_symbol,
    name,
    iso_currency_code: currency_name.toUpperCase(),
    close_price: priceResult.data,
    close_price_as_of: getDateTimeString(date),
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
  };
};

/**
 * Clear the price cache (useful for testing)
 */
export const clearPriceCache = () => {
  priceCache.clear();
};
