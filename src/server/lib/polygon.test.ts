import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { getClosePrice, getTickerDetail, clearPriceCache } from "./polygon";

// Store original env and fetch
const originalEnv = process.env.POLYGON_API_KEY;
const originalFetch = globalThis.fetch;

describe("polygon", () => {
  beforeEach(() => {
    clearPriceCache();
  });

  afterEach(() => {
    process.env.POLYGON_API_KEY = originalEnv;
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
});
