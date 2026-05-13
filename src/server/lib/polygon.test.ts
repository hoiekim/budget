import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  getClosePrice,
  getTickerDetail,
  clearPriceCache,
  __resetPolygonRateLimit,
} from "./polygon";

// Store original env and fetch
const originalEnv = process.env.POLYGON_API_KEY;
const originalRateLimit = process.env.POLYGON_RATE_LIMIT_PER_MIN;
const originalFetch = globalThis.fetch;

describe("polygon", () => {
  beforeEach(() => {
    clearPriceCache();
    __resetPolygonRateLimit();
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
    globalThis.fetch = originalFetch;
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

  describe("rate limit", () => {
    // The rate-limit gate sits between cache-miss and the actual fetch. With
    // cap=2/min, the third call should block waiting for the oldest token to
    // age out. We approximate "wait" by stubbing Date.now to march forward.
    it("releases the third call once the first token ages out of the 60s window", async () => {
      process.env.POLYGON_API_KEY = "test-key";
      process.env.POLYGON_RATE_LIMIT_PER_MIN = "2";
      __resetPolygonRateLimit();

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
      __resetPolygonRateLimit();

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
});
