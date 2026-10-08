/**
 * Yahoo Finance chart API as the keyless fallback for tickers Polygon does
 * not carry — chiefly mutual funds (e.g. VFIAX), which are NAV-priced and
 * never touch an exchange tape. Unofficial endpoint; it is only ever
 * consulted after Polygon answers `no_data`, never as the primary source.
 *
 * https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range=5d
 */

import { getDateString, JSONSecurity, Queue, QueueWaitTimeoutError } from "common";
import { logger } from "./logger";
import type { PolygonResult, TickerDetail } from "./polygon";

const YAHOO_HOST = "https://query1.finance.yahoo.com";

// Yahoo rejects non-browser user agents on this endpoint.
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Yahoo is unofficial and IP-rate-limited, so keep the cadence gentle. The
// fallback only fires on Polygon misses, which are rare by construction.
const DEFAULT_RATE_LIMIT_PER_MIN = 30;

const getRateLimitPerMin = (): number => {
  const raw = process.env.YAHOO_RATE_LIMIT_PER_MIN;
  if (raw === undefined || raw === "") return DEFAULT_RATE_LIMIT_PER_MIN;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RATE_LIMIT_PER_MIN;
  return Math.floor(n);
};

export const yahooQueue = new Queue({ capacity: getRateLimitPerMin });

/** Same foreground budget as Polygon — a form should fail retryable, not hang. */
export const FOREGROUND_QUEUE_WAIT_MS = 5_000;

interface FetchOptions {
  maxWaitMs?: number;
  securityType?: JSONSecurity["type"];
}

/**
 * Yahoo's crypto convention is `{BASE}-USD` (e.g. `BTC-USD`), mirroring
 * Polygon's `X:{BASE}USD` mapping in `toPolygonTicker`.
 */
export const toYahooTicker = (
  ticker_symbol: string,
  securityType?: JSONSecurity["type"],
): string => {
  if (securityType !== "cryptocurrency") return ticker_symbol;
  if (ticker_symbol.endsWith("-USD")) return ticker_symbol;
  return `${ticker_symbol}-USD`;
};

const priceCache = new Map<string, { price: number; fetchedAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const missCache = new Map<string, number>();
const MISS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const detailCache = new Map<string, { detail: TickerDetail; fetchedAt: number }>();

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

interface YahooChartResult {
  meta?: {
    currency?: string;
    longName?: string;
    shortName?: string;
    instrumentType?: string;
    regularMarketPrice?: number;
  };
  timestamp?: number[];
  indicators?: { quote?: Array<{ close?: Array<number | null> }> };
}

interface YahooChartResponse {
  chart?: {
    result?: YahooChartResult[] | null;
    error?: { code?: string; description?: string } | null;
  };
}

const rateLimitedResult = (ticker: string): PolygonResult<never> => ({
  success: false,
  error: "rate_limited",
  message: `Market data is busy right now; retry the lookup for ${ticker} in a moment.`,
});

/**
 * Fetch one chart response. A 200 with `chart.error` (or a null result) is
 * Yahoo's "no such symbol" — the only answer that may be memoized as a miss.
 * 429 is a refusal, not a verdict on the symbol.
 */
const fetchChart = async (
  yahooTicker: string,
  query: string,
  maxWaitMs?: number,
): Promise<PolygonResult<YahooChartResult> | { success: true; data: YahooChartResult }> => {
  const path = `${YAHOO_HOST}/v8/finance/chart/${encodeURIComponent(yahooTicker)}?${query}`;
  let response: Response;
  try {
    response = await yahooQueue.add(
      () =>
        fetch(path, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        }),
      { maxWaitMs },
    );
  } catch (err) {
    if (err instanceof QueueWaitTimeoutError) return rateLimitedResult(yahooTicker);
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Yahoo API error for ${yahooTicker}: ${message}`, { component: "yahoo" });
    return { success: false, error: "api_error", message: `Failed to fetch ${yahooTicker}: ${message}` };
  }

  if (response.status === 429) return rateLimitedResult(yahooTicker);

  let json: YahooChartResponse;
  try {
    json = (await response.json()) as YahooChartResponse;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: "api_error", message: `Bad response for ${yahooTicker}: ${message}` };
  }

  const result = json.chart?.result?.[0];
  if (!result) {
    return {
      success: false,
      error: "no_data",
      message: `No Yahoo data found for ${yahooTicker}`,
    };
  }
  return { success: true, data: result };
};

const dateStringOfTimestamp = (t: number): string => {
  const d = new Date(t * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};

export const getTickerDetail = async (
  ticker_symbol: string,
  options: FetchOptions = {},
): Promise<PolygonResult<TickerDetail>> => {
  const { securityType, maxWaitMs } = options;
  const yahooTicker = toYahooTicker(ticker_symbol, securityType);

  const cached = detailCache.get(yahooTicker);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { success: true, data: cached.detail };
  }

  const missKey = `detail:${yahooTicker}`;
  if (isRecentMiss(missKey)) {
    return { success: false, error: "no_data", message: `No Yahoo data found for ${ticker_symbol}` };
  }

  const chart = await fetchChart(yahooTicker, "interval=1d&range=5d", maxWaitMs);
  if (!chart.success) {
    if (chart.error === "no_data") rememberMiss(missKey);
    return chart.error === "no_data"
      ? { success: false, error: "no_data", message: `No Yahoo data found for ${ticker_symbol}` }
      : chart;
  }

  const meta = chart.data.meta ?? {};
  const detail: TickerDetail = {
    ticker_symbol,
    name: meta.longName || meta.shortName || ticker_symbol,
    currency_name: meta.currency || "USD",
  };
  detailCache.set(yahooTicker, { detail, fetchedAt: Date.now() });
  return { success: true, data: detail };
};

export const getClosePrice = async (
  ticker_symbol: string,
  date: Date,
  options: FetchOptions = {},
): Promise<PolygonResult<number>> => {
  const { securityType, maxWaitMs } = options;
  const yahooTicker = toYahooTicker(ticker_symbol, securityType);
  const dateString = getDateString(date);
  const cacheKey = `${yahooTicker}:${dateString}`;

  const cached = priceCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { success: true, data: cached.price };
  }

  const missKey = `price:${cacheKey}`;
  if (isRecentMiss(missKey)) {
    return {
      success: false,
      error: "no_data",
      message: `No Yahoo price data available for ${ticker_symbol} on ${dateString}`,
    };
  }

  // 3-day window around the target; the bar whose UTC date matches wins.
  // Mutual-fund NAV bars land on the date itself.
  const dayMs = 24 * 60 * 60 * 1000;
  const target = new Date(`${dateString}T00:00:00Z`).getTime();
  const period1 = Math.floor((target - dayMs) / 1000);
  const period2 = Math.floor((target + 2 * dayMs) / 1000);

  const chart = await fetchChart(yahooTicker, `interval=1d&period1=${period1}&period2=${period2}`, maxWaitMs);
  if (!chart.success) {
    if (chart.error === "no_data") rememberMiss(missKey);
    return chart.error === "no_data"
      ? {
          success: false,
          error: "no_data",
          message: `No Yahoo price data available for ${ticker_symbol} on ${dateString}`,
        }
      : chart;
  }

  const timestamps = chart.data.timestamp ?? [];
  const closes = chart.data.indicators?.quote?.[0]?.close ?? [];
  for (let i = 0; i < timestamps.length; i++) {
    if (dateStringOfTimestamp(timestamps[i]) === dateString) {
      const close = closes[i];
      if (typeof close === "number" && Number.isFinite(close)) {
        priceCache.set(cacheKey, { price: close, fetchedAt: Date.now() });
        return { success: true, data: close };
      }
    }
  }

  rememberMiss(missKey);
  return {
    success: false,
    error: "no_data",
    message: `No Yahoo price data available for ${ticker_symbol} on ${dateString}`,
  };
};

/**
 * Latest daily close at or before `date`, mirroring Polygon's
 * `getLatestClosePriceOnOrBefore` — the refresh pass's trading-day resolver.
 */
export const getLatestClosePriceOnOrBefore = async (
  ticker_symbol: string,
  dateOrString: Date | string,
  options: FetchOptions & { lookbackDays?: number } = {},
): Promise<PolygonResult<{ price: number; tradingDate: string }>> => {
  const { lookbackDays = 7, securityType, maxWaitMs } = options;
  const yahooTicker = toYahooTicker(ticker_symbol, securityType);

  const to = typeof dateOrString === "string" ? dateOrString.slice(0, 10) : getDateString(dateOrString);

  const missKey = `range:${yahooTicker}:${to}:${lookbackDays}`;
  if (isRecentMiss(missKey)) {
    return {
      success: false,
      error: "no_data",
      message: `No Yahoo price data for ${ticker_symbol} on or before ${to}`,
    };
  }

  const chart = await fetchChart(yahooTicker, `interval=1d&range=${lookbackDays + 2}d`, maxWaitMs);
  if (!chart.success) {
    if (chart.error === "no_data") rememberMiss(missKey);
    return chart.error === "no_data"
      ? {
          success: false,
          error: "no_data",
          message: `No Yahoo price data for ${ticker_symbol} on or before ${to}`,
        }
      : chart;
  }

  const timestamps = chart.data.timestamp ?? [];
  const closes = chart.data.indicators?.quote?.[0]?.close ?? [];
  for (let i = timestamps.length - 1; i >= 0; i--) {
    const tradingDate = dateStringOfTimestamp(timestamps[i]);
    if (tradingDate > to) continue;
    const close = closes[i];
    if (typeof close === "number" && Number.isFinite(close)) {
      return { success: true, data: { price: close, tradingDate } };
    }
  }

  rememberMiss(missKey);
  return {
    success: false,
    error: "no_data",
    message: `No Yahoo price data for ${ticker_symbol} on or before ${to}`,
  };
};

/**
 * Clear the price cache, the ticker-detail cache and the empty-result memo
 * (useful for testing)
 */
export const clearYahooCache = () => {
  priceCache.clear();
  detailCache.clear();
  missCache.clear();
};
