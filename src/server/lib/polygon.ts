/**
 * We use polygon API to get stock price data, etc.
 * https://polygon.io/docs/stocks/getting-started
 */

import { getDateString, getDateTimeString, getRandomId, JSONSecurity } from "common";

const POLYGON_HOST = "https://api.polygon.io";

// Helper to get API key at runtime (for testability)
const getApiKey = () => process.env.POLYGON_API_KEY;

// Warn on startup if API key is missing
if (!getApiKey()) {
  console.warn("POLYGON_API_KEY not set - stock price fetching will be disabled");
}

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

/**
 * Fetch with retry logic for transient failures
 */
const fetchWithRetry = async (
  url: string,
  maxRetries = 2,
  delayMs = 1000
): Promise<Response> => {
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
  date: Date
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
    console.error(`Polygon API error for ${ticker_symbol}: ${message}`);
    return {
      success: false,
      error: "api_error",
      message: `Failed to fetch price for ${ticker_symbol}: ${message}`,
    };
  }
};

export const getTickerDetail = async (
  ticker_symbol: string
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
    console.error(`Polygon API error for ticker detail ${ticker_symbol}: ${message}`);
    return {
      success: false,
      error: "api_error",
      message: `Failed to fetch ticker details for ${ticker_symbol}: ${message}`,
    };
  }
};

export const getSecurityForSymbol = async (
  ticker_symbol: string,
  date = new Date()
): Promise<JSONSecurity | undefined> => {
  const [priceResult, detailResult] = await Promise.all([
    getClosePrice(ticker_symbol, date),
    getTickerDetail(ticker_symbol),
  ]);

  // Log errors but return undefined for backward compatibility
  if (!priceResult.success) {
    console.warn(`getSecurityForSymbol: ${priceResult.message}`);
    return undefined;
  }
  if (!detailResult.success) {
    console.warn(`getSecurityForSymbol: ${detailResult.message}`);
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
