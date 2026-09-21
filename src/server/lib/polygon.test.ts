import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { restoreFetch } from "test-helpers";
import {
  getClosePrice,
  getLatestClosePriceOnOrBefore,
  getTickerDetail,
  clearPriceCache,
  polygonQueue,
} from "./polygon";

// Store original env
const originalEnv = process.env.POLYGON_API_KEY;
const originalRateLimit = process.env.POLYGON_RATE_LIMIT_PER_MIN;

describe("polygon", () => {
  beforeEach(() => {
    clearPriceCache();
    polygonQueue.reset();
    // Disable rate limiting in tests by default so the standard tests don't
    // burn 12 seconds waiting for token refills. Individual rate-limit
    // tests re-enable it explicitly.
    process.env.POLYGON_RATE_LIMIT_PER_MIN = "0";
  });

  afterEach(() => {
    process.env.POLYGON_API_KEY = originalEnv;
    if (originalRateLimit === undefined) {
      delete process.env.POLYGON_RATE_LIMIT_PER_MIN;
    } else {
      process.env.POLYGON_RATE_LIMIT_PER_MIN = originalRateLimit;
    }
    restoreFetch();
  });

  describe("getClosePrice", () => {
    it("returns no_api_key error when POLYGON_API_KEY is not set", async () => {
      process.env.POLYGON_API_KEY = "";

      const result = await getClosePrice("AAPL", new Date("2024-01-15"));

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("no_api_key");
      }
    });

    it("returns price data on successful response", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      globalThis.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ results: [{ c: 185.5 }] }),
        } as Response)
      );

      const result = await getClosePrice("AAPL", new Date("2024-01-15"));

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(185.5);
      }
    });

    it("returns no_data error when results array is empty", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      globalThis.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ results: [] }),
        } as Response)
      );

      const result = await getClosePrice("INVALID", new Date("2024-01-15"));

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("no_data");
      }
    });

    it("returns api_error on network failure", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      globalThis.fetch = mock(() => Promise.reject(new Error("Network error")));

      const result = await getClosePrice("AAPL", new Date("2024-01-15"));

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("api_error");
        expect(result.message).toContain("Network error");
      }
    });

    it("uses cached value on second call", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      let callCount = 0;
      globalThis.fetch = mock(() => {
        callCount++;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ results: [{ c: 185.5 }] }),
        } as Response);
      });

      const date = new Date("2024-01-15");
      await getClosePrice("AAPL", date);
      await getClosePrice("AAPL", date);

      expect(callCount).toBe(1); // Only one fetch call
    });
  });

  describe("getTickerDetail", () => {
    it("returns no_api_key error when POLYGON_API_KEY is not set", async () => {
      process.env.POLYGON_API_KEY = "";

      const result = await getTickerDetail("AAPL");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("no_api_key");
      }
    });

    it("returns ticker details on successful response", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      globalThis.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              results: { name: "Apple Inc.", currency_name: "usd" },
            }),
        } as Response)
      );

      const result = await getTickerDetail("AAPL");

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.ticker_symbol).toBe("AAPL");
        expect(result.data.name).toBe("Apple Inc.");
        expect(result.data.currency_name).toBe("usd");
      }
    });

    it("returns no_data error when results is missing", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      globalThis.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({}),
        } as Response)
      );

      const result = await getTickerDetail("INVALID");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("no_data");
      }
    });
  });

  describe("getLatestClosePriceOnOrBefore", () => {
    it("returns no_api_key error when key is not set", async () => {
      process.env.POLYGON_API_KEY = "";
      const result = await getLatestClosePriceOnOrBefore("AAPL", new Date("2024-01-15"));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBe("no_api_key");
    });

    it("returns the latest entry in the response range with its trading date", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      const tFri = Date.UTC(2024, 0, 12);
      const tThu = Date.UTC(2024, 0, 11);
      globalThis.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              results: [
                { c: 184, t: tThu },
                { c: 185, t: tFri },
              ],
            }),
        } as Response),
      );

      const result = await getLatestClosePriceOnOrBefore("AAPL", new Date("2024-01-13"));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.price).toBe(185);
        expect(result.data.tradingDate).toBe("2024-01-12");
      }
    });

    it("returns no_data when response has no results", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      globalThis.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ results: [] }),
        } as Response),
      );
      const result = await getLatestClosePriceOnOrBefore("AAPL", new Date("2024-01-15"));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBe("no_data");
    });

    it("requests a date range ending at the given date with configurable lookback", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      const seen: string[] = [];
      globalThis.fetch = mock((url: string) => {
        seen.push(url);
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              results: [{ c: 100, t: Date.UTC(2024, 0, 15) }],
            }),
        } as Response);
      });

      await getLatestClosePriceOnOrBefore("AAPL", "2024-01-15", { lookbackDays: 3 });
      expect(seen.length).toBe(1);
      expect(seen[0]).toContain("/range/1/day/2024-01-12/2024-01-15");
    });

    it("returns plan_limit when Polygon responds with NOT_AUTHORIZED", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      globalThis.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              status: "NOT_AUTHORIZED",
              message: "Your plan doesn't include this data timeframe.",
            }),
        } as Response),
      );

      const result = await getLatestClosePriceOnOrBefore("VOO", "2020-01-15");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("plan_limit");
        expect(result.message).toContain("plan");
      }
    });

    it("preserves the trading date across timezones (UTC components, not local getDate())", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      globalThis.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              results: [{ c: 472.5, t: Date.UTC(2024, 0, 15) }],
            }),
        } as Response),
      );

      const result = await getLatestClosePriceOnOrBefore("VOO", "2024-01-15");
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.tradingDate).toBe("2024-01-15");
    });
  });

  describe("crypto ticker namespace", () => {
    const captureUrls = (price = 100) => {
      const seen: string[] = [];
      globalThis.fetch = mock((url: string) => {
        seen.push(url);
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ results: [{ c: price, t: Date.UTC(2024, 0, 15) }] }),
        } as Response);
      });
      return seen;
    };

    it("getClosePrice requests X:{ticker}USD for a cryptocurrency security", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      const seen = captureUrls();

      await getClosePrice("BTC", new Date("2024-01-15"), { securityType: "cryptocurrency" });

      expect(seen.length).toBe(1);
      expect(seen[0]).toContain("/v2/aggs/ticker/X:BTCUSD/range/1/day/");
    });

    it("getClosePrice keeps the bare ticker for non-crypto types", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      const seen = captureUrls();

      await getClosePrice("BTC", new Date("2024-01-15"), { securityType: "equity" });
      await getClosePrice("VOO", new Date("2024-01-15"), { securityType: null });
      await getClosePrice("AAPL", new Date("2024-01-15"));

      expect(seen[0]).toContain("/v2/aggs/ticker/BTC/range/1/day/");
      expect(seen[1]).toContain("/v2/aggs/ticker/VOO/range/1/day/");
      expect(seen[2]).toContain("/v2/aggs/ticker/AAPL/range/1/day/");
    });

    it("does not double-prefix a ticker already in the crypto namespace", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      const seen = captureUrls();

      await getClosePrice("X:ETHUSD", new Date("2024-01-15"), { securityType: "cryptocurrency" });

      expect(seen[0]).toContain("/v2/aggs/ticker/X:ETHUSD/range/1/day/");
      expect(seen[0]).not.toContain("X:X:");
    });

    it("a crypto lookup is never satisfied by the equity cache entry for the same ticker string", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      const prices = [34.17, 110312.56];
      const seen: string[] = [];
      globalThis.fetch = mock((url: string) => {
        seen.push(url);
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ results: [{ c: prices[seen.length - 1] }] }),
        } as Response);
      });

      const date = new Date("2024-01-15");
      const equity = await getClosePrice("BTC", date, { securityType: "equity" });
      const crypto = await getClosePrice("BTC", date, { securityType: "cryptocurrency" });

      expect(seen.length).toBe(2);
      expect(equity.success && equity.data).toBe(34.17);
      expect(crypto.success && crypto.data).toBe(110312.56);
    });

    it("getLatestClosePriceOnOrBefore requests X:{ticker}USD for a cryptocurrency security", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      const seen = captureUrls();

      await getLatestClosePriceOnOrBefore("BTC", "2024-01-15", { securityType: "cryptocurrency" });

      expect(seen.length).toBe(1);
      expect(seen[0]).toContain("/v2/aggs/ticker/X:BTCUSD/range/1/day/");
    });
  });

  describe("rate limit", () => {
    // The rate-limit gate sits between cache-miss and the actual fetch. With
    // cap=2/min, the third call should block waiting for the oldest token to
    // age out. We approximate "wait" by stubbing Date.now to march forward.
    it("releases the third call once the first token ages out of the 60s window", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      process.env.POLYGON_RATE_LIMIT_PER_MIN = "2";
      polygonQueue.reset();

      // Stable time anchor and a synthetic clock the test can advance.
      let now = 1_700_000_000_000;
      const realDateNow = Date.now;
      const realSetTimeout = globalThis.setTimeout;
      Date.now = () => now;
      // Make setTimeout immediate and advance `now` by the requested ms, so
      // the gate's `sleepMs` doesn't actually wait wall-clock time.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).setTimeout = ((fn: () => void, ms: number) => {
        now += ms;
        return realSetTimeout(fn, 0);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any;

      let fetchCalls = 0;
      globalThis.fetch = mock(() => {
        fetchCalls++;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ results: [{ c: 1 + fetchCalls }] }),
        } as Response);
      });

      try {
        // 3 distinct dates so the cache doesn't satisfy any of them.
        await getClosePrice("AAPL", new Date("2024-01-15"));
        await getClosePrice("AAPL", new Date("2024-02-15"));
        await getClosePrice("AAPL", new Date("2024-03-15"));

        expect(fetchCalls).toBe(3);
        // The third call must have waited at least to the 60s mark from
        // the first token's timestamp. Our synthetic clock advanced by
        // sleepMs, so `now` should now be ≥ anchor + 60s.
        expect(now).toBeGreaterThanOrEqual(1_700_000_000_000 + 60_000);
      } finally {
        Date.now = realDateNow;
        globalThis.setTimeout = realSetTimeout;
      }
    });

    it("does not consume a token on a cache hit", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      process.env.POLYGON_RATE_LIMIT_PER_MIN = "1";
      polygonQueue.reset();

      let fetchCalls = 0;
      globalThis.fetch = mock(() => {
        fetchCalls++;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ results: [{ c: 200 }] }),
        } as Response);
      });

      const date = new Date("2024-01-15");
      await getClosePrice("AAPL", date);
      const before = Date.now();
      await getClosePrice("AAPL", date); // identical → cache hit
      const after = Date.now();

      expect(fetchCalls).toBe(1);
      // Cache hit shouldn't have routed through the gate (it's after the
      // cache check), so no measurable wait was introduced.
      expect(after - before).toBeLessThan(20);
    });
  });

  describe("empty-result memo", () => {
    const countingFetch = (json: unknown) => {
      let calls = 0;
      globalThis.fetch = mock(() => {
        calls++;
        return Promise.resolve({ ok: true, json: () => Promise.resolve(json) } as Response);
      });
      return () => calls;
    };

    it("getClosePrice does not re-fetch a symbol that just came back empty", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      const calls = countingFetch({ results: [] });
      const date = new Date("2024-01-15");

      const first = await getClosePrice("NOSUCH", date);
      const second = await getClosePrice("NOSUCH", date);

      expect(calls()).toBe(1);
      expect(first.success).toBe(false);
      expect(second.success).toBe(false);
      if (!second.success) expect(second.error).toBe("no_data");
    });

    it("getTickerDetail does not re-fetch a symbol that just came back empty", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      const calls = countingFetch({});

      await getTickerDetail("NOSUCH");
      const second = await getTickerDetail("NOSUCH");

      expect(calls()).toBe(1);
      expect(second.success).toBe(false);
      if (!second.success) expect(second.error).toBe("no_data");
    });

    it("getLatestClosePriceOnOrBefore does not re-fetch a range that just came back empty", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      const calls = countingFetch({ results: [] });

      await getLatestClosePriceOnOrBefore("NOSUCH", "2024-01-15");
      const second = await getLatestClosePriceOnOrBefore("NOSUCH", "2024-01-15");

      expect(calls()).toBe(1);
      expect(second.success).toBe(false);
      if (!second.success) expect(second.error).toBe("no_data");
    });

    it("memoizes per symbol, not globally", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      const calls = countingFetch({ results: [] });
      const date = new Date("2024-01-15");

      await getClosePrice("NOSUCH", date);
      await getClosePrice("ALSONOSUCH", date);

      expect(calls()).toBe(2);
    });

    it("keeps the price and detail memos apart", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      const calls = countingFetch({ results: [] });

      await getClosePrice("NOSUCH", new Date("2024-01-15"));
      await getTickerDetail("NOSUCH");

      expect(calls()).toBe(2);
    });

    it("does not memoize an api_error, which may be transient", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      let calls = 0;
      globalThis.fetch = mock(() => {
        calls++;
        return Promise.resolve({
          ok: true,
          json: () => Promise.reject(new Error("malformed payload")),
        } as unknown as Response);
      });

      const first = await getTickerDetail("AAPL");
      const second = await getTickerDetail("AAPL");

      expect(calls).toBe(2);
      expect(first.success).toBe(false);
      if (!first.success) expect(first.error).toBe("api_error");
      expect(second.success).toBe(false);
      if (!second.success) expect(second.error).toBe("api_error");
    });

    it("does not memoize a 429 error envelope as a missing price", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      let calls = 0;
      globalThis.fetch = mock(() => {
        calls++;
        if (calls === 1) {
          return Promise.resolve({
            ok: false,
            status: 429,
            json: () =>
              Promise.resolve({ status: "ERROR", error: "exceeded maximum requests" }),
          } as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ results: [{ c: 402.5 }] }),
        } as Response);
      });
      const date = new Date("2024-01-15");

      const first = await getClosePrice("AAPL", date);
      const second = await getClosePrice("AAPL", date);

      expect(calls).toBe(2);
      expect(first.success).toBe(false);
      if (!first.success) expect(first.error).toBe("api_error");
      expect(second.success).toBe(true);
      if (second.success) expect(second.data).toBe(402.5);
    });

    it("does not memoize a plan rejection as a missing ticker", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      let calls = 0;
      globalThis.fetch = mock(() => {
        calls++;
        if (calls === 1) {
          return Promise.resolve({
            ok: false,
            status: 403,
            json: () => Promise.resolve({ status: "NOT_AUTHORIZED" }),
          } as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({ results: { name: "Microsoft Corp.", currency_name: "usd" } }),
        } as Response);
      });

      const first = await getTickerDetail("MSFT");
      const second = await getTickerDetail("MSFT");

      expect(calls).toBe(2);
      expect(first.success).toBe(false);
      if (!first.success) expect(first.error).toBe("plan_limit");
      expect(second.success).toBe(true);
      if (second.success) expect(second.data.name).toBe("Microsoft Corp.");
    });

    it("does not memoize an error envelope that arrived on a 200", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      let calls = 0;
      globalThis.fetch = mock(() => {
        calls++;
        if (calls === 1) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({ status: "ERROR", error: "invalid date range requested" }),
          } as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ results: [{ c: 402.5 }] }),
        } as Response);
      });
      const date = new Date("2024-01-15");

      const first = await getClosePrice("AAPL", date);
      const second = await getClosePrice("AAPL", date);

      expect(calls).toBe(2);
      expect(first.success).toBe(false);
      if (!first.success) expect(first.error).toBe("api_error");
      expect(second.success).toBe(true);
      if (second.success) expect(second.data).toBe(402.5);
    });

    it("memoizes a 404, which is Polygon saying it does not carry the symbol", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      let calls = 0;
      globalThis.fetch = mock(() => {
        calls++;
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({ status: "NOT_FOUND" }),
        } as Response);
      });

      const first = await getTickerDetail("NOSUCH");
      const second = await getTickerDetail("NOSUCH");

      expect(calls).toBe(1);
      expect(first.success).toBe(false);
      if (!first.success) expect(first.error).toBe("no_data");
      expect(second.success).toBe(false);
      if (!second.success) expect(second.error).toBe("no_data");
    });
  });

  describe("ticker-detail cache", () => {
    it("serves a repeated detail lookup without spending a second call", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      let calls = 0;
      globalThis.fetch = mock(() => {
        calls++;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({ results: { name: "Apple Inc.", currency_name: "usd" } }),
        } as Response);
      });

      const first = await getTickerDetail("AAPL");
      const second = await getTickerDetail("AAPL");

      expect(calls).toBe(1);
      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      if (second.success) expect(second.data.name).toBe("Apple Inc.");
    });
  });

  describe("ticker encoding", () => {
    it("keeps the api key on its own query parameter when the symbol carries one", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      const seen: string[] = [];
      globalThis.fetch = mock((url: string) => {
        seen.push(url);
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
      });

      await getTickerDetail("AAPL?apiKey=stolen");

      expect(seen.length).toBe(1);
      expect(seen[0]).toBe(
        "https://api.polygon.io/v3/reference/tickers/AAPL%3FapiKey%3Dstolen?apiKey=test-key",
      );
    });

    it("leaves the crypto namespace colon intact", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      const seen: string[] = [];
      globalThis.fetch = mock((url: string) => {
        seen.push(url);
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
      });

      await getTickerDetail("X:BTCUSD");

      expect(seen[0]).toContain("/v3/reference/tickers/X:BTCUSD?apiKey=");
    });
  });

  describe("foreground wait budget", () => {
    it("sheds with rate_limited rather than parking on a saturated gate", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      process.env.POLYGON_RATE_LIMIT_PER_MIN = "1";
      polygonQueue.reset();

      let calls = 0;
      globalThis.fetch = mock(() => {
        calls++;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ results: [{ c: 10 }] }),
        } as Response);
      });

      await getClosePrice("AAPL", new Date("2024-01-15"));
      const shed = await getClosePrice("MSFT", new Date("2024-01-15"), { maxWaitMs: 10 });

      expect(shed.success).toBe(false);
      if (!shed.success) expect(shed.error).toBe("rate_limited");
      expect(calls).toBe(1);
    });
  });
});
