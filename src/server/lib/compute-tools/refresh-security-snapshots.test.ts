//
// `refreshActiveSecuritySnapshots` reads holdings + securities from
// `pool.query` / `searchSecuritiesById` and calls
// `polygon.getLatestClosePriceOnOrBefore` for each non-cash security.
// The bundle inlines polygon, so we leaf-mock `pg` for the DB layer and
// `globalThis.fetch` for polygon. The polygon module reads
// `process.env.POLYGON_API_KEY` / `POLYGON_RATE_LIMIT_PER_MIN` once at
// module load — set them BEFORE importing so:
//   1. polygon doesn't short-circuit `no_api_key`.
//   2. The rate-limit queue runs at capacity=0 (no throttling).
//
// The fetch override + env writes are process-global; `afterAll`
// restores the originals so this file doesn't leak into other suites.
const originalFetch = globalThis.fetch;
const originalApiKey = process.env.POLYGON_API_KEY;
const originalRateLimit = process.env.POLYGON_RATE_LIMIT_PER_MIN;

process.env.POLYGON_API_KEY = "test-key";
process.env.POLYGON_RATE_LIMIT_PER_MIN = "0";

import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";

const mockQuery = mock(async (_sql: string, _values?: unknown[]) => ({
  rows: [] as unknown[],
  rowCount: 0 as number | null,
}));

class FakePool {
  query = mockQuery;
  end = async () => {};
  connect = async () => ({ query: mockQuery, release: () => {} });
}

mock.module("pg", () => ({
  Pool: FakePool,
  types: { setTypeParser: () => {} },
  default: { Pool: FakePool, types: { setTypeParser: () => {} } },
}));

const mockFetch = mock(
  async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> =>
    new Response(JSON.stringify({ results: [{ c: 100, t: Date.UTC(2026, 5, 10) }] }), {
      status: 200,
    }),
);
globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

const { refreshActiveSecuritySnapshots, clearPriceCache } = await import(
  "./refresh-security-snapshots"
).then(async (m) => {
  const polygon = await import("../polygon");
  return { ...m, clearPriceCache: polygon.clearPriceCache };
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.POLYGON_API_KEY;
  else process.env.POLYGON_API_KEY = originalApiKey;
  if (originalRateLimit === undefined) delete process.env.POLYGON_RATE_LIMIT_PER_MIN;
  else process.env.POLYGON_RATE_LIMIT_PER_MIN = originalRateLimit;
  restoreLeaves();
});

// SQL router. Each test stages:
//   - holdingsRows   → DISTINCT security_id query result
//   - securitiesRows → per-id securities row (one queryOne per id in searchSecuritiesById)
//   - existingByPair → existence probe set, key = `${security_id}|${tradingDate}`
let holdingsRows: Array<{ security_id: string }> = [];
let securitiesRows: Array<Record<string, unknown>> = [];
let existingByPair = new Set<string>();
const upsertCalls: Array<{ sql: string; values: unknown[] }> = [];

const queryRouter = async (sql: string, values?: unknown[]) => {
  const params = (values ?? []) as unknown[];

  if (/SELECT\s+DISTINCT\s+security_id\s+FROM\s+holdings/i.test(sql)) {
    return { rows: holdingsRows, rowCount: holdingsRows.length };
  }

  if (/SELECT\s+\*\s+FROM\s+securities/i.test(sql)) {
    const wantId = params[0];
    const row = securitiesRows.find((r) => r.security_id === wantId);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }

  if (
    /FROM\s+snapshots\s+WHERE\s+security_id\s*=\s*\$1\s+AND\s+snapshot_type\s*=\s*'security'/is.test(
      sql,
    )
  ) {
    const key = `${params[0]}|${params[1]}`;
    const found = existingByPair.has(key);
    return { rows: found ? [{ snapshot_id: "exists" }] : [], rowCount: found ? 1 : 0 };
  }

  if (/INSERT\s+INTO\s+snapshots/i.test(sql)) {
    upsertCalls.push({ sql, values: params });
    return { rows: [], rowCount: 1 };
  }

  return { rows: [], rowCount: 0 };
};

// Helper to override fetch per-test with a custom polygon response.
const setPolygonResponse = (body: unknown, status = 200) => {
  mockFetch.mockImplementationOnce(
    async () => new Response(JSON.stringify(body), { status }),
  );
};

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockImplementation(queryRouter);
  mockFetch.mockReset();
  mockFetch.mockImplementation(
    async () =>
      new Response(JSON.stringify({ results: [{ c: 100, t: Date.UTC(2026, 5, 10) }] }), {
        status: 200,
      }),
  );
  clearPriceCache();
  holdingsRows = [];
  securitiesRows = [];
  existingByPair = new Set();
  upsertCalls.length = 0;
});

const securityRow = (overrides: Record<string, unknown> = {}) => ({
  security_id: "sec-1",
  ticker_symbol: "AAPL",
  name: "Apple Inc.",
  iso_currency_code: "USD",
  close_price: null,
  close_price_as_of: null,
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
  raw: null,
  updated: null,
  is_deleted: false,
  ...overrides,
});

describe("refreshActiveSecuritySnapshots", () => {
  test("no holdings → no polygon calls, all counters 0", async () => {
    const r = await refreshActiveSecuritySnapshots();
    expect(r).toEqual({ refreshed: 0, fresh: 0, cash: 0, empty: 0, errors: 0 });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("one referenced ticker → polygon called, snapshot upserted", async () => {
    holdingsRows = [{ security_id: "sec-1" }];
    securitiesRows = [securityRow({ security_id: "sec-1", ticker_symbol: "AAPL" })];

    const r = await refreshActiveSecuritySnapshots();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(upsertCalls).toHaveLength(1);
    expect(r.refreshed).toBe(1);
    expect(r.fresh).toBe(0);
    expect(r.cash).toBe(0);
    // The upserted row's snapshot_id derives from polygon's returned
    // tradingDate (Date.UTC(2026, 5, 10) → 2026-06-10 → 20260610),
    // not "today" — proves idempotency anchors on tradingDate.
    expect(upsertCalls[0].values.some((v) => String(v) === "sec-1-20260610")).toBe(true);
  });

  test("cash (type='cash') is skipped — no polygon call", async () => {
    holdingsRows = [{ security_id: "cash-1" }];
    securitiesRows = [
      securityRow({ security_id: "cash-1", ticker_symbol: "CUR:USD", type: "cash" }),
    ];
    const r = await refreshActiveSecuritySnapshots();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(r.cash).toBe(1);
    expect(r.refreshed).toBe(0);
  });

  test("cash (CUR:* ticker without type='cash') is also skipped", async () => {
    holdingsRows = [{ security_id: "cash-2" }];
    securitiesRows = [
      securityRow({ security_id: "cash-2", ticker_symbol: "CUR:EUR", type: null }),
    ];
    const r = await refreshActiveSecuritySnapshots();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(r.cash).toBe(1);
  });

  test("snapshot already exists for tradingDate → no upsert, increments `fresh`", async () => {
    holdingsRows = [{ security_id: "sec-1" }];
    securitiesRows = [securityRow({ security_id: "sec-1", ticker_symbol: "VOO" })];
    existingByPair.add("sec-1|2026-06-10");

    const r = await refreshActiveSecuritySnapshots();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(upsertCalls).toHaveLength(0);
    expect(r.fresh).toBe(1);
    expect(r.refreshed).toBe(0);
  });

  test("polygon `no_data` → counted as empty, no upsert", async () => {
    holdingsRows = [{ security_id: "sec-2" }];
    securitiesRows = [securityRow({ security_id: "sec-2", ticker_symbol: "DELISTED" })];
    setPolygonResponse({ results: [] });
    const r = await refreshActiveSecuritySnapshots();
    expect(upsertCalls).toHaveLength(0);
    expect(r.empty).toBe(1);
    expect(r.errors).toBe(0);
  });

  test("polygon NOT_AUTHORIZED → counted as error", async () => {
    holdingsRows = [{ security_id: "sec-3" }];
    securitiesRows = [securityRow({ security_id: "sec-3", ticker_symbol: "PLAN_GATED" })];
    setPolygonResponse({ status: "NOT_AUTHORIZED", message: "out of plan" });
    const r = await refreshActiveSecuritySnapshots();
    expect(upsertCalls).toHaveLength(0);
    expect(r.errors).toBe(1);
    expect(r.empty).toBe(0);
  });

  test("upsert failure → counted as error, loop continues for the next security", async () => {
    holdingsRows = [{ security_id: "sec-1" }, { security_id: "sec-2" }];
    securitiesRows = [
      securityRow({ security_id: "sec-1", ticker_symbol: "AAPL" }),
      securityRow({ security_id: "sec-2", ticker_symbol: "MSFT" }),
    ];
    let insertCount = 0;
    mockQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (/INSERT\s+INTO\s+snapshots/i.test(sql)) {
        insertCount++;
        if (insertCount === 1) throw new Error("db down");
        upsertCalls.push({ sql, values: (values ?? []) as unknown[] });
        return { rows: [], rowCount: 1 };
      }
      return queryRouter(sql, values);
    });

    const r = await refreshActiveSecuritySnapshots();
    expect(r.errors).toBe(1);
    expect(r.refreshed).toBe(1);
  });

  test("multi-security mix: cash + fresh + new", async () => {
    holdingsRows = [
      { security_id: "sec-cash" },
      { security_id: "sec-fresh" },
      { security_id: "sec-new" },
    ];
    securitiesRows = [
      securityRow({ security_id: "sec-cash", ticker_symbol: "CUR:USD", type: "cash" }),
      securityRow({ security_id: "sec-fresh", ticker_symbol: "VOO" }),
      securityRow({ security_id: "sec-new", ticker_symbol: "NVDA" }),
    ];
    existingByPair.add("sec-fresh|2026-06-10");

    const r = await refreshActiveSecuritySnapshots();
    expect(r.cash).toBe(1);
    expect(r.fresh).toBe(1);
    expect(r.refreshed).toBe(1);
    expect(upsertCalls).toHaveLength(1);
  });

  test("tickerless securities skipped (no polygon call, no error)", async () => {
    holdingsRows = [{ security_id: "sec-no-ticker" }];
    securitiesRows = [securityRow({ security_id: "sec-no-ticker", ticker_symbol: null })];
    const r = await refreshActiveSecuritySnapshots();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(r).toEqual({ refreshed: 0, fresh: 0, cash: 0, empty: 0, errors: 0 });
  });

  test("existence probe scopes by (security_id, tradingDate)", async () => {
    holdingsRows = [{ security_id: "sec-a" }, { security_id: "sec-b" }];
    securitiesRows = [
      securityRow({ security_id: "sec-a", ticker_symbol: "AAPL" }),
      securityRow({ security_id: "sec-b", ticker_symbol: "MSFT" }),
    ];
    existingByPair.add("sec-a|2026-06-10");

    const r = await refreshActiveSecuritySnapshots();
    expect(r.fresh).toBe(1);
    expect(r.refreshed).toBe(1);
    expect(upsertCalls).toHaveLength(1);
  });
});
