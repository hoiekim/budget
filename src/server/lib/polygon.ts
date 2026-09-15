/**
 * We use polygon API to get stock price data, etc.
 * https://polygon.io/docs/stocks/getting-started
 */

import {
  getDateString,
  getDateTimeString,
  getRandomId,
  JSONSecurity,
  Queue,
  QueueWaitTimeoutError,
} from "common";
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
 * Wait budget for a request a person is watching. The background backfill
 * and refresh passes have no deadline and keep queueing, but a form that
 * has been spinning for this long is better served by a retryable failure
 * than by a slot it would hold away from everyone else.
 */
export const FOREGROUND_QUEUE_WAIT_MS = 5_000;

interface FetchOptions {
  /** Overrides the queue's default unbounded wait. See `FOREGROUND_QUEUE_WAIT_MS`. */
  maxWaitMs?: number;
}

export interface TickerDetail {
  ticker_symbol: string;
  name: string;
  currency_name: string;
}

/**
 * Result types for Polygon API calls
 */
export type PolygonResult<T> =
  | { success: true; data: T }
  | {
      success: false;
      error: "no_api_key" | "api_error" | "no_data" | "plan_limit" | "rate_limited";
      message: string;
    };

/**
 * Polygon namespaces crypto separately from US equities: a bare `BTC`
 * addresses the US-listed equity trading under that ticker, while Bitcoin
 * lives at `X:BTCUSD`. Map cryptocurrency securities onto the `X:{BASE}USD`
 * pair so their lookups never resolve to a same-ticker stock.
 */
export const toPolygonTicker = (
  ticker_symbol: string,
  securityType?: JSONSecurity["type"],
): string => {
  if (securityType !== "cryptocurrency") return ticker_symbol;
  if (ticker_symbol.startsWith("X:")) return ticker_symbol;
  return `X:${ticker_symbol}USD`;
};

/**
 * Simple in-memory cache for price data
 * Key format: `${polygonTicker}:${dateString}` — the resolved polygon
 * ticker, so an equity and a crypto sharing a ticker string cache apart.
 */
const priceCache = new Map<string, { price: number; fetchedAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Lookups that came back empty, keyed by the same identity as the positive
 * cache. Without it a symbol Polygon does not know is the one lookup that
 * can never be served warm, so repeating it costs a rate slot every time
 * while a valid symbol costs one only once. The TTL is short because an
 * empty answer can turn into a real one within the day — a freshly listed
 * symbol, or today's close once the session settles.
 */
const missCache = new Map<string, number>();
const MISS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const isRecentMiss = (key: string): boolean => {
  const missedAt = missCache.get(key);
  if (missedAt === undefined) return false;
  if (Date.now() - missedAt >= MISS_CACHE_TTL_MS) {
    missCache.delete(key);
    return false;
  }
  return true;
};

const rememberMiss = (key: string): void => {
  missCache.set(key, Date.now());
};

/**
 * Ticker details that resolved. The securities table is the durable cache,
 * but a caller can ask for a detail without ever saving one — the Add Holding
 * form checks a symbol with `save: false` — so without this a repeated check
 * of a symbol that *is* valid costs a rate slot every time.
 */
const detailCache = new Map<string, { detail: TickerDetail; fetchedAt: number }>();

// Periodically evict stale cache entries to prevent unbounded growth.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of priceCache) {
    if (now - entry.fetchedAt >= CACHE_TTL_MS) priceCache.delete(key);
  }
  for (const [key, missedAt] of missCache) {
    if (now - missedAt >= MISS_CACHE_TTL_MS) missCache.delete(key);
  }
  for (const [key, entry] of detailCache) {
    if (now - entry.fetchedAt >= CACHE_TTL_MS) detailCache.delete(key);
  }
}, CACHE_TTL_MS).unref();

/**
 * Neutralize anything that could end the path or open a query string — the
 * API key is appended after the ticker, so a raw `?` or `#` would truncate
 * the URL and send the call out unauthenticated. `:` is left alone: it is a
 * legal path character and carries Polygon's crypto namespace (`X:BTCUSD`).
 */
const encodeTicker = (ticker: string): string =>
  encodeURIComponent(ticker).replace(/%3A/g, ":");

const rateLimitedResult = (polygonTicker: string): PolygonResult<never> => ({
  success: false,
  error: "rate_limited",
  message: `Market data is busy right now; retry the lookup for ${polygonTicker} in a moment.`,
});

/**
 * Polygon reports a refused call in the body rather than in the shape: a 429
 * or a plan rejection carries an error envelope and no `results`, which
 * absence alone cannot tell apart from a symbol that genuinely has no data.
 * Memoizing one of those answers "no such symbol" for the whole TTL, process
 * wide, for a symbol that exists. Returns the failure to surface, or
 * undefined when the empty answer is real and may be memoized — a 404 is how
 * Polygon says it does not carry the symbol, so it stays on that side.
 */
const upstreamRefusal = (
  response: Response,
  json: { status?: unknown; message?: unknown; error?: unknown },
  subject: string,
): PolygonResult<never> | undefined => {
  if (json.status === "NOT_AUTHORIZED") {
    return {
      success: false,
      error: "plan_limit",
      message:
        typeof json.message === "string"
          ? json.message
          : `Polygon plan does not include data for ${subject}`,
    };
  }
  if ((response.ok || response.status === 404) && json.status !== "ERROR") return undefined;
  return {
    success: false,
    error: "api_error",
    message:
      typeof json.error === "string"
        ? json.error
        : `Polygon refused the lookup for ${subject} (HTTP ${response.status})`,
  };
};

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
  options: FetchOptions & { securityType?: JSONSecurity["type"] } = {},
): Promise<PolygonResult<number>> => {
  const { securityType, maxWaitMs } = options;
  if (!getApiKey()) {
    return {
      success: false,
      error: "no_api_key",
      message: "Polygon API key not configured",
    };
  }

  const polygonTicker = toPolygonTicker(ticker_symbol, securityType);
  const dateString = getDateString(date);
  const cacheKey = `${polygonTicker}:${dateString}`;

  // Check cache first
  const cached = priceCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { success: true, data: cached.price };
  }

  const missKey = `price:${cacheKey}`;
  if (isRecentMiss(missKey)) {
    return {
      success: false,
      error: "no_data",
      message: `No price data available for ${polygonTicker} on ${dateString}`,
    };
  }

  const from = dateString;
  const to = dateString;
  const tickerParameter = `ticker/${encodeTicker(polygonTicker)}`;
  const rangeParameter = `range/1/day/${from}/${to}`;
  const path = `${POLYGON_HOST}/v2/aggs/${tickerParameter}/${rangeParameter}?apiKey=${getApiKey()}`;

  try {
    // Queue gate sits AFTER cache check so warm reads don't consume a slot.
    const response = await polygonQueue.add(() => fetchWithRetry(path), { maxWaitMs });
    const json = await response.json();

    const refusal = upstreamRefusal(response, json, polygonTicker);
    if (refusal) return refusal;

    if (!json.results || json.results.length === 0) {
      rememberMiss(missKey);
      return {
        success: false,
        error: "no_data",
        message: `No price data available for ${polygonTicker} on ${dateString}`,
      };
    }

    const price = json.results[0].c as number;

    // Cache successful result
    priceCache.set(cacheKey, { price, fetchedAt: Date.now() });

    return { success: true, data: price };
  } catch (err) {
    if (err instanceof QueueWaitTimeoutError) return rateLimitedResult(polygonTicker);
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Polygon API error for ${polygonTicker}: ${message}`, { component: "polygon" });
    return {
      success: false,
      error: "api_error",
      message: `Failed to fetch price for ${polygonTicker}: ${message}`,
    };
  }
};

export const getTickerDetail = async (
  ticker_symbol: string,
  options: FetchOptions = {},
): Promise<PolygonResult<TickerDetail>> => {
  if (!getApiKey()) {
    return {
      success: false,
      error: "no_api_key",
      message: "Polygon API key not configured",
    };
  }

  const cached = detailCache.get(ticker_symbol);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { success: true, data: cached.detail };
  }

  const missKey = `detail:${ticker_symbol}`;
  if (isRecentMiss(missKey)) {
    return {
      success: false,
      error: "no_data",
      message: `No ticker details found for ${ticker_symbol}`,
    };
  }

  const path = `${POLYGON_HOST}/v3/reference/tickers/${encodeTicker(ticker_symbol)}?apiKey=${getApiKey()}`;

  try {
    // Same queue as getClosePrice — a backfill pass that uses both endpoints
    // stays under the per-minute cap across both methods.
    const response = await polygonQueue.add(() => fetchWithRetry(path), {
      maxWaitMs: options.maxWaitMs,
    });
    const json = await response.json();

    const refusal = upstreamRefusal(response, json, ticker_symbol);
    if (refusal) return refusal;

    if (!json.results) {
      rememberMiss(missKey);
      return {
        success: false,
        error: "no_data",
        message: `No ticker details found for ${ticker_symbol}`,
      };
    }

    const detail: TickerDetail = {
      ticker_symbol,
      name: json.results.name as string,
      currency_name: json.results.currency_name as string,
    };
    detailCache.set(ticker_symbol, { detail, fetchedAt: Date.now() });

    return { success: true, data: detail };
  } catch (err) {
    if (err instanceof QueueWaitTimeoutError) return rateLimitedResult(ticker_symbol);
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
  options: FetchOptions & {
    lookbackDays?: number;
    securityType?: JSONSecurity["type"];
  } = {},
): Promise<PolygonResult<{ price: number; tradingDate: string }>> => {
  const { lookbackDays = 7, securityType, maxWaitMs } = options;
  if (!getApiKey()) {
    return { success: false, error: "no_api_key", message: "Polygon API key not configured" };
  }

  const polygonTicker = toPolygonTicker(ticker_symbol, securityType);

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

  const missKey = `range:${polygonTicker}:${from}:${to}`;
  if (isRecentMiss(missKey)) {
    return {
      success: false,
      error: "no_data",
      message: `No price data for ${polygonTicker} in [${from}, ${to}]`,
    };
  }

  const path = `${POLYGON_HOST}/v2/aggs/ticker/${encodeTicker(polygonTicker)}/range/1/day/${from}/${to}?apiKey=${getApiKey()}`;

  try {
    const response = await polygonQueue.add(() => fetchWithRetry(path), { maxWaitMs });
    const json = await response.json();
    const refusal = upstreamRefusal(response, json, `${polygonTicker} in [${from}, ${to}]`);
    if (refusal) return refusal;
    const results = json.results as Array<{ c: number; t: number }> | undefined;
    if (!results || results.length === 0) {
      rememberMiss(missKey);
      return {
        success: false,
        error: "no_data",
        message: `No price data for ${polygonTicker} in [${from}, ${to}]`,
      };
    }
    const last = results[results.length - 1];
    const td = new Date(last.t);
    const tradingDate = `${td.getUTCFullYear()}-${String(td.getUTCMonth() + 1).padStart(2, "0")}-${String(td.getUTCDate()).padStart(2, "0")}`;
    return { success: true, data: { price: last.c, tradingDate } };
  } catch (err) {
    if (err instanceof QueueWaitTimeoutError) return rateLimitedResult(polygonTicker);
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Polygon range fetch error for ${polygonTicker}: ${message}`, {
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
 * Clear the price cache, the ticker-detail cache and the empty-result memo
 * (useful for testing)
 */
export const clearPriceCache = () => {
  priceCache.clear();
  detailCache.clear();
  missCache.clear();
};
