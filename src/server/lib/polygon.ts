/**
 * We use polygon API to get stock price data, etc.
 * https://polygon.io/docs/stocks/getting-started
 */

import { getDateString, getDateTimeString, getRandomId, JSONSecurity } from "common";
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
// out to dozens of calls per security on first-seen accounts, so we route
// every outbound polygon request through a token bucket to avoid 429s and
// the noisy retry backoff that follows.
//
// `POLYGON_RATE_LIMIT_PER_MIN` (env, default 5) caps the bucket size and
// refill rate. Setting it to 0 disables the gate entirely (useful for paid
// tiers / tests). When the bucket is empty, callers `await` for the next
// refill — no queueing, no dropping. The 1-min window slides per token.

const DEFAULT_RATE_LIMIT_PER_MIN = 5;

const getRateLimitPerMin = (): number => {
  const raw = process.env.POLYGON_RATE_LIMIT_PER_MIN;
  if (raw === undefined || raw === "") return DEFAULT_RATE_LIMIT_PER_MIN;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RATE_LIMIT_PER_MIN;
  return Math.floor(n);
};

// Timestamps (ms) of the in-flight tokens consumed in the last 60s.
// At rate-limit acquire time we evict anything older than 60s and check
// whether `tokensUsed.length < cap`. If yes — emit a token, push now.
// If no — `await` until the oldest token would age out, then retry.
const tokensUsed: number[] = [];

const acquirePolygonToken = async (): Promise<void> => {
  const cap = getRateLimitPerMin();
  if (cap <= 0) return; // gate disabled

  // Re-check in a loop to handle multiple concurrent waiters fairly.
  while (true) {
    const now = Date.now();
    const cutoff = now - 60_000;
    while (tokensUsed.length > 0 && tokensUsed[0]! <= cutoff) tokensUsed.shift();
    if (tokensUsed.length < cap) {
      tokensUsed.push(now);
      return;
    }
    const oldest = tokensUsed[0]!;
    const sleepMs = Math.max(10, oldest + 60_000 - now);
    await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
  }
};

/** Test-only: drain the in-memory token bucket so each test starts fresh. */
export const __resetPolygonRateLimit = () => {
  tokensUsed.length = 0;
};

/**
 * Result types for Polygon API calls
 */
export type PolygonResult<T> =
  | { success: true; data: T }
  | { success: false; error: "no_api_key" | "api_error" | "no_data"; message: string };

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

  // Rate-limit gate AFTER cache check so cache hits don't consume tokens.
  await acquirePolygonToken();

  const from = dateString;
  const to = dateString;
  const tickerParameter = `ticker/${ticker_symbol}`;
  const rangeParameter = `range/1/day/${from}/${to}`;
  const path = `${POLYGON_HOST}/v2/aggs/${tickerParameter}/${rangeParameter}?apiKey=${getApiKey()}`;

  try {
    const response = await fetchWithRetry(path);
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

  // Rate-limit gate — same bucket as getClosePrice, so a single backfill
  // pass that uses both endpoints stays under the per-minute cap.
  await acquirePolygonToken();

  const path = `${POLYGON_HOST}/v3/reference/tickers/${ticker_symbol}?apiKey=${getApiKey()}`;

  try {
    const response = await fetchWithRetry(path);
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
