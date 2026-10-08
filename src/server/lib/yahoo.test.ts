import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { restoreFetch } from "test-helpers";
import { getDateString } from "common";
import {
  getClosePrice,
  getLatestClosePriceOnOrBefore,
  getTickerDetail,
  toYahooTicker,
  clearYahooCache,
  yahooQueue,
} from "./yahoo";

const originalRateLimit = process.env.YAHOO_RATE_LIMIT_PER_MIN;

const ts = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / 1000);

const chartOk = (opts: {
  longName?: string;
  shortName?: string;
  currency?: string;
  timestamps?: number[];
  closes?: Array<number | null>;
} = {}) => ({
  chart: {
    result: [
      {
        meta: {
          currency: opts.currency ?? "USD",
          longName: opts.longName ?? "Vanguard 500 Index Admiral",
          shortName: opts.shortName ?? "Vanguard 500 Index Fd Admiral S",
          instrumentType: "MUTUALFUND",
          regularMarketPrice: 720.06,
        },
        timestamp: opts.timestamps ?? [ts(2026, 10, 5), ts(2026, 10, 6), ts(2026, 10, 7)],
        indicators: { quote: [{ close: opts.closes ?? [718.5, 720.06, 721.0] }] },
      },
    ],
    error: null,
  },
});

const chartNotFound = () => ({
  chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } },
});

const mockJson = (json: unknown, status = 200) =>
  mock(() =>
    Promise.resolve({
      ok: status === 200,
      status,
      json: () => Promise.resolve(json),
    } as Response),
  );

describe("yahoo", () => {
  beforeEach(() => {
    clearYahooCache();
    yahooQueue.reset();
    // No waiting on the rate gate in tests.
    process.env.YAHOO_RATE_LIMIT_PER_MIN = "0";
  });

  afterEach(() => {
    if (originalRateLimit === undefined) {
      delete process.env.YAHOO_RATE_LIMIT_PER_MIN;
    } else {
      process.env.YAHOO_RATE_LIMIT_PER_MIN = originalRateLimit;
    }
    restoreFetch();
  });

  describe("toYahooTicker", () => {
    it("maps crypto to Yahoo's BASE-USD convention", () => {
      expect(toYahooTicker("BTC", "cryptocurrency")).toBe("BTC-USD");
      expect(toYahooTicker("BTC-USD", "cryptocurrency")).toBe("BTC-USD");
    });

    it("passes equities through untouched", () => {
      expect(toYahooTicker("VFIAX")).toBe("VFIAX");
      expect(toYahooTicker("AAPL", "equity")).toBe("AAPL");
    });
  });

  describe("getTickerDetail", () => {
    it("returns the long name and currency from chart meta", async () => {
      globalThis.fetch = mockJson(chartOk());

      const result = await getTickerDetail("VFIAX");

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.ticker_symbol).toBe("VFIAX");
        expect(result.data.name).toBe("Vanguard 500 Index Admiral");
        expect(result.data.currency_name).toBe("USD");
      }
    });

    it("falls back to shortName, then the ticker itself", async () => {
      globalThis.fetch = mockJson({
        chart: {
          result: [
            {
              meta: { currency: "USD", instrumentType: "MUTUALFUND" },
              timestamp: [ts(2026, 10, 6)],
              indicators: { quote: [{ close: [720.06] }] },
            },
          ],
          error: null,
        },
      });

      const result = await getTickerDetail("VFIAX");

      expect(result.success).toBe(true);
      if (result.success) expect(result.data.name).toBe("VFIAX");
    });

    it("returns no_data for an unknown symbol", async () => {
      globalThis.fetch = mockJson(chartNotFound());

      const result = await getTickerDetail("NOSUCHTICKER");

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBe("no_data");
    });

    it("memoizes misses so a repeat costs no fetch", async () => {
      const f = mockJson(chartNotFound());
      globalThis.fetch = f;

      await getTickerDetail("NOSUCHTICKER");
      await getTickerDetail("NOSUCHTICKER");

      expect(f).toHaveBeenCalledTimes(1);
    });

    it("serves details from cache", async () => {
      const f = mockJson(chartOk());
      globalThis.fetch = f;

      await getTickerDetail("VFIAX");
      await getTickerDetail("VFIAX");

      expect(f).toHaveBeenCalledTimes(1);
    });

    it("sends a browser User-Agent (Yahoo rejects bare clients)", async () => {
      const f = mockJson(chartOk());
      globalThis.fetch = f;

      await getTickerDetail("VFIAX");

      const init = f.mock.calls[0]?.[1] as RequestInit | undefined;
      const ua = (init?.headers as Record<string, string> | undefined)?.["User-Agent"];
      expect(ua).toMatch(/Mozilla/);
    });

    it("maps a 429 to rate_limited, not no_data", async () => {
      globalThis.fetch = mockJson({ chart: { result: null, error: { code: "Too Many Requests" } } }, 429);

      const result = await getTickerDetail("VFIAX");

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBe("rate_limited");
    });

    it("maps a network failure to api_error", async () => {
      globalThis.fetch = mock(() => Promise.reject(new Error("Network error")));

      const result = await getTickerDetail("VFIAX");

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBe("api_error");
    });
  });

  describe("getClosePrice", () => {
    // `getDateString` renders in local time, so derive the target date
    // string the same way the implementation does and build bars around it
    // — otherwise the test breaks outside UTC.
    const targetDate = () => new Date("2026-10-06T12:00:00Z");
    const barTs = (offsetDays: number) => {
      const [y, m, d] = getDateString(targetDate()).split("-").map(Number);
      return Math.floor(Date.UTC(y, m - 1, d + offsetDays) / 1000);
    };

    it("returns the close of the bar matching the date", async () => {
      globalThis.fetch = mockJson(
        chartOk({ timestamps: [barTs(-1), barTs(0), barTs(1)], closes: [718.5, 720.06, 721.0] }),
      );

      const result = await getClosePrice("VFIAX", targetDate());

      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toBe(720.06);
    });

    it("returns no_data when no bar matches the date", async () => {
      globalThis.fetch = mockJson(chartOk({ timestamps: [barTs(-5)], closes: [700.0] }));

      const result = await getClosePrice("VFIAX", targetDate());

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBe("no_data");
    });

    it("skips null closes", async () => {
      globalThis.fetch = mockJson(chartOk({ timestamps: [barTs(0)], closes: [null] }));

      const result = await getClosePrice("VFIAX", targetDate());

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBe("no_data");
    });
  });

  describe("getLatestClosePriceOnOrBefore", () => {
    it("returns the latest bar at or before the date", async () => {
      globalThis.fetch = mockJson(chartOk());

      // 2026-10-07 is a Wednesday; ask as of 2026-10-08 (Thursday) — the
      // 10-07 bar is the latest at-or-before.
      const result = await getLatestClosePriceOnOrBefore("VFIAX", "2026-10-08");

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.price).toBe(721.0);
        expect(result.data.tradingDate).toBe("2026-10-07");
      }
    });

    it("skips bars after the date", async () => {
      globalThis.fetch = mockJson(chartOk());

      const result = await getLatestClosePriceOnOrBefore("VFIAX", "2026-10-06");

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.price).toBe(720.06);
        expect(result.data.tradingDate).toBe("2026-10-06");
      }
    });

    it("returns no_data when every bar is null", async () => {
      globalThis.fetch = mockJson(chartOk({ closes: [null, null, null] }));

      const result = await getLatestClosePriceOnOrBefore("VFIAX", "2026-10-08");

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBe("no_data");
    });
  });
});
