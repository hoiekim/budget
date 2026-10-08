import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { restoreFetch } from "test-helpers";
import { getDateString } from "common";
import {
  getTickerDetailWithFallback,
  getClosePriceWithFallback,
  getLatestClosePriceOnOrBeforeWithFallback,
} from "./market-data";
import { clearPriceCache as clearPolygonCache, polygonQueue } from "./polygon";
import { clearYahooCache, yahooQueue } from "./yahoo";

const originalPolyKey = process.env.POLYGON_API_KEY;
const originalPolyRate = process.env.POLYGON_RATE_LIMIT_PER_MIN;
const originalYahooRate = process.env.YAHOO_RATE_LIMIT_PER_MIN;

// Yahoo bar timestamp derived from the local date string, the same way the
// implementation matches bars — keeps the test green outside UTC.
const yahooBarTs = (date: Date) => {
  const [y, m, d] = getDateString(date).split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 1000);
};

const yahooDetail = (ticker: string, date = new Date("2026-10-06T12:00:00Z")) => ({
  chart: {
    result: [
      {
        meta: { currency: "USD", longName: "Vanguard 500 Index Admiral" },
        timestamp: [yahooBarTs(date)],
        indicators: { quote: [{ close: [720.06] }] },
      },
    ],
    error: null,
  },
});

/**
 * Route by host: Polygon answers empty (no_data), Yahoo answers per
 * `yahooJson`. Counts calls per provider.
 */
const routeMocks = (yahooJson: unknown) => {
  const calls = { polygon: 0, yahoo: 0 };
  const f = mock(async (url: string) => {
    if (url.includes("api.polygon.io")) {
      calls.polygon++;
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }
    calls.yahoo++;
    return { ok: true, status: 200, json: async () => yahooJson } as unknown as Response;
  });
  globalThis.fetch = f as unknown as typeof globalThis.fetch;
  return calls;
};

describe("market-data fallback", () => {
  beforeEach(() => {
    clearPolygonCache();
    clearYahooCache();
    polygonQueue.reset();
    yahooQueue.reset();
    process.env.POLYGON_API_KEY = "test-key";
    process.env.POLYGON_RATE_LIMIT_PER_MIN = "0";
    process.env.YAHOO_RATE_LIMIT_PER_MIN = "0";
  });

  afterEach(() => {
    if (originalPolyKey === undefined) delete process.env.POLYGON_API_KEY;
    else process.env.POLYGON_API_KEY = originalPolyKey;
    if (originalPolyRate === undefined) delete process.env.POLYGON_RATE_LIMIT_PER_MIN;
    else process.env.POLYGON_RATE_LIMIT_PER_MIN = originalPolyRate;
    if (originalYahooRate === undefined) delete process.env.YAHOO_RATE_LIMIT_PER_MIN;
    else process.env.YAHOO_RATE_LIMIT_PER_MIN = originalYahooRate;
    restoreFetch();
  });

  it("returns the Polygon result without touching Yahoo when Polygon succeeds", async () => {
    const calls = { polygon: 0, yahoo: 0 };
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("api.polygon.io")) {
        calls.polygon++;
        return {
          ok: true,
          status: 200,
          json: async () => ({ results: { name: "Apple Inc.", currency_name: "usd" } }),
        } as unknown as Response;
      }
      calls.yahoo++;
      return { ok: true, status: 200, json: async () => yahooDetail("AAPL") } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

    const result = await getTickerDetailWithFallback("AAPL");

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe("Apple Inc.");
    expect(calls.yahoo).toBe(0);
  });

  it("falls back to Yahoo when Polygon has no data", async () => {
    const calls = routeMocks(yahooDetail("VFIAX"));

    const result = await getTickerDetailWithFallback("VFIAX");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ticker_symbol).toBe("VFIAX");
      expect(result.data.name).toBe("Vanguard 500 Index Admiral");
    }
    expect(calls.polygon).toBe(1);
    expect(calls.yahoo).toBe(1);
  });

  it("does not fall back when Polygon refuses (only no_data is a verdict on the symbol)", async () => {
    const calls = { polygon: 0, yahoo: 0 };
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("api.polygon.io")) {
        calls.polygon++;
        // A 429 from upstream surfaces as api_error in polygon.ts (the
        // rate_limited error comes from the queue gate, not the fetch).
        return { ok: false, status: 429, json: async () => ({}) } as unknown as Response;
      }
      calls.yahoo++;
      return { ok: true, status: 200, json: async () => yahooDetail("AAPL") } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

    const result = await getTickerDetailWithFallback("AAPL");

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe("api_error");
    expect(calls.yahoo).toBe(0);
  });

  it("does not fall back when Polygon errors", async () => {
    const calls = { polygon: 0, yahoo: 0 };
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("api.polygon.io")) {
        calls.polygon++;
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: "ERROR", error: "upstream is unhappy" }),
        } as unknown as Response;
      }
      calls.yahoo++;
      return { ok: true, status: 200, json: async () => yahooDetail("AAPL") } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

    const result = await getTickerDetailWithFallback("AAPL");

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe("api_error");
    expect(calls.yahoo).toBe(0);
  });

  it("returns Yahoo's no_data when neither provider knows the symbol", async () => {
    const calls = routeMocks({ chart: { result: null, error: { code: "Not Found" } } });

    const result = await getTickerDetailWithFallback("NOSUCHTICKER");

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe("no_data");
    expect(calls.polygon).toBe(1);
    expect(calls.yahoo).toBe(1);
  });

  it("falls back for close prices too", async () => {
    const date = new Date("2026-10-06T12:00:00Z");
    routeMocks(yahooDetail("VFIAX", date));

    const result = await getClosePriceWithFallback("VFIAX", date);

    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(720.06);
  });

  it("falls back for the trading-day resolver too", async () => {
    const date = new Date("2026-10-06T12:00:00Z");
    routeMocks(yahooDetail("VFIAX", date));
    const tradingDate = getDateString(date);

    const result = await getLatestClosePriceOnOrBeforeWithFallback("VFIAX", "2026-10-08");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.price).toBe(720.06);
      expect(result.data.tradingDate).toBe(tradingDate);
    }
  });
});
