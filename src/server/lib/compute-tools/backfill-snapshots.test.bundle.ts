// Per-test-bundle isolation — see scripts/test-bundled/.
//
// `backfillMonthlySecuritySnapshotsForward` lost its four DI seams
// (searchSecuritiesById / getSecuritySnapshots / upsertSnapshots /
// getClosePrice). The function now calls into the real repositories
// and `polygon.getClosePrice` directly; the bundle inlines all of
// that, so we leaf-mock `pg` for the DB layer and `globalThis.fetch`
// for polygon. The bundle's polygon module reads
// `process.env.POLYGON_API_KEY` / `POLYGON_RATE_LIMIT_PER_MIN` on
// every call, so we set them BEFORE importing the bundle to ensure:
//   1. `getClosePrice` doesn't early-return `no_api_key`.
//   2. The polygon rate-limit queue is disabled (capacity=0).
// Each test uses a unique ticker so polygon's 1-hour priceCache
// (also inlined in the bundle) never collides across tests.
// @bundles src/server/lib/compute-tools/backfill-snapshots.ts
process.env.POLYGON_API_KEY = "test-key";
process.env.POLYGON_RATE_LIMIT_PER_MIN = "0";

import { describe, test, expect, mock, beforeEach } from "bun:test";

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
    new Response(JSON.stringify({ results: [{ c: 100 }] }), { status: 200 }),
);
globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

const { backfillMonthlySecuritySnapshotsForward } = await import("./backfill-snapshots");

/**
 * Per-test routing for SQL. The repositories layer fires:
 *   - SELECT against `securities` (searchSecuritiesById → getSecurity)
 *   - SELECT against `snapshots`  (getSecuritySnapshots)
 *   - INSERT/UPDATE against `securities`/`snapshots` (upsertSnapshots)
 * Tests stage rows by writing to `securitiesRows`/`snapshotsRows`.
 * INSERTs/UPDATEs use the default `{rows:[], rowCount:0}` response —
 * upsertSnapshots ignores the result body anyway.
 */
let securitiesRows: Array<Record<string, unknown>> = [];
let snapshotsRows: Array<Record<string, unknown>> = [];

const queryRouter = async (sql: string, _values?: unknown[]) => {
  const isSelect = /^\s*SELECT\b/i.test(sql);
  if (isSelect && /\bFROM\s+securities\b/i.test(sql)) {
    return { rows: securitiesRows, rowCount: securitiesRows.length };
  }
  if (isSelect && /\bFROM\s+snapshots\b/i.test(sql)) {
    return { rows: snapshotsRows, rowCount: snapshotsRows.length };
  }
  return { rows: [], rowCount: 0 };
};

const makeSecurityRow = (overrides: Record<string, unknown> = {}) => ({
  security_id: "sec-1",
  ticker_symbol: "TKR",
  name: "Test Security",
  type: "equity",
  close_price: 100,
  close_price_as_of: "2026-05-01",
  iso_currency_code: "USD",
  isin: null,
  cusip: null,
  raw: null,
  updated: null,
  is_deleted: false,
  ...overrides,
});

const makeSnapshotRow = (overrides: Record<string, unknown> = {}) => ({
  snapshot_id: "snap-1",
  snapshot_date: "2026-04-15",
  snapshot_type: "security",
  security_id: "sec-1",
  close_price: 90,
  is_deleted: false,
  ...overrides,
});

/** Override the next N polygon calls with custom responses. FIFO. */
let fetchResponses: Array<(url: string) => Response | Promise<Response>> = [];
const enqueueFetch = (responder: (url: string) => Response | Promise<Response>) => {
  fetchResponses.push(responder);
};

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockImplementation(queryRouter);
  securitiesRows = [];
  snapshotsRows = [];

  mockFetch.mockReset();
  fetchResponses = [];
  mockFetch.mockImplementation(async (url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    const next = fetchResponses.shift();
    if (next) return next(urlStr);
    // Default: polygon success, close = 100.
    return new Response(JSON.stringify({ results: [{ c: 100 }] }), { status: 200 });
  });
});

/** Polygon fetch calls inside the bundle. */
const polygonCalls = (): string[] =>
  mockFetch.mock.calls
    .map((c) => {
      const u = c[0];
      return typeof u === "string" ? u : u instanceof URL ? u.toString() : (u as Request).url;
    })
    .filter((u) => u.includes("api.polygon.io"));

/** Extract the `/range/1/day/{from}/{to}` date from a polygon close-price URL. */
const polygonFromDate = (url: string): string => {
  const m = url.match(/\/range\/1\/day\/(\d{4}-\d{2}-\d{2})\//);
  if (!m) throw new Error(`No /range/1/day/<from>/ segment in ${url}`);
  return m[1];
};

describe("backfillMonthlySecuritySnapshotsForward", () => {
  test("returns zero counts on empty refs", async () => {
    const result = await backfillMonthlySecuritySnapshotsForward([]);
    expect(result).toEqual({ filled: 0, skipped: 0, empty: 0, errors: 0 });
    // No DB or polygon traffic on the empty path.
    expect(mockQuery).toHaveBeenCalledTimes(0);
    expect(polygonCalls()).toHaveLength(0);
  });

  test("fills monthly snapshots from fromDate forward to current month", async () => {
    securitiesRows = [makeSecurityRow({ security_id: "sec-a", ticker_symbol: "TKR-A" })];

    const now = new Date();
    const fromDate = new Date(now.getFullYear(), now.getMonth() - 3, 15).toISOString();

    const result = await backfillMonthlySecuritySnapshotsForward([
      { security_id: "sec-a", fromDate },
    ]);

    // 4 months in range (fromMonth, +1, +2, +3=current). All filled.
    expect(result.filled).toBe(4);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
    expect(polygonCalls()).toHaveLength(4);
  });

  test("skips months that already have a snapshot", async () => {
    securitiesRows = [makeSecurityRow({ security_id: "sec-b", ticker_symbol: "TKR-B" })];

    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);
    snapshotsRows = [
      makeSnapshotRow({
        snapshot_id: "existing",
        snapshot_date: lastMonth.toISOString().slice(0, 10),
        security_id: "sec-b",
      }),
    ];

    const fromDate = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();

    const result = await backfillMonthlySecuritySnapshotsForward([
      { security_id: "sec-b", fromDate },
    ]);

    // 2 months (last + current). Last is skipped, current is filled.
    expect(result.filled).toBe(1);
    expect(result.skipped).toBe(1);
    expect(polygonCalls()).toHaveLength(1);
  });

  test("skips cash-type securities entirely", async () => {
    securitiesRows = [
      makeSecurityRow({ security_id: "sec-cash", ticker_symbol: "CUR:USD", type: "cash" }),
    ];

    const fromDate = new Date(new Date().getFullYear() - 1, 0, 1).toISOString();

    const result = await backfillMonthlySecuritySnapshotsForward([
      { security_id: "sec-cash", fromDate },
    ]);

    expect(result.filled).toBe(0);
    expect(polygonCalls()).toHaveLength(0);
    // searchSecuritiesById still SELECTs the security; getSecuritySnapshots is NOT called.
    const snapshotSelects = mockQuery.mock.calls.filter((c) =>
      /\bFROM\s+snapshots\b/i.test(c[0] as string),
    );
    expect(snapshotSelects).toHaveLength(0);
  });

  test("skips securities whose ticker starts with CUR: regardless of type", async () => {
    // Defensive: some Plaid items report cash with no `type` set but a `CUR:` ticker.
    securitiesRows = [
      makeSecurityRow({ security_id: "sec-eur", ticker_symbol: "CUR:EUR", type: null }),
    ];
    const fromDate = new Date(new Date().getFullYear(), 0, 1).toISOString();

    const result = await backfillMonthlySecuritySnapshotsForward([
      { security_id: "sec-eur", fromDate },
    ]);

    expect(result.filled).toBe(0);
    expect(polygonCalls()).toHaveLength(0);
  });

  test("does NOT reach into months before fromDate (forward-only)", async () => {
    securitiesRows = [makeSecurityRow({ security_id: "sec-c", ticker_symbol: "TKR-C" })];

    // fromDate = current month → only the current month should fire.
    const now = new Date();
    const fromDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const result = await backfillMonthlySecuritySnapshotsForward([
      { security_id: "sec-c", fromDate },
    ]);

    expect(result.filled).toBe(1);
    expect(polygonCalls()).toHaveLength(1);
  });

  test("uses yesterday's date for current-month snapshot (today hasn't closed yet)", async () => {
    securitiesRows = [makeSecurityRow({ security_id: "sec-d", ticker_symbol: "TKR-D" })];

    const now = new Date();
    const fromDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    await backfillMonthlySecuritySnapshotsForward([{ security_id: "sec-d", fromDate }]);

    // The single polygon call for the current month should target yesterday,
    // not today — today's market hasn't closed.
    const urls = polygonCalls();
    expect(urls).toHaveLength(1);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(polygonFromDate(urls[0])).toBe(yesterday.toISOString().slice(0, 10));
  });

  test("does NOT call polygon when fromDate is in the future", async () => {
    securitiesRows = [makeSecurityRow({ security_id: "sec-e", ticker_symbol: "TKR-E" })];

    const now = new Date();
    const future = new Date(now.getFullYear() + 1, 5, 15).toISOString();

    const result = await backfillMonthlySecuritySnapshotsForward([
      { security_id: "sec-e", fromDate: future },
    ]);

    expect(result.filled).toBe(0);
    expect(polygonCalls()).toHaveLength(0);
  });

  test("counts polygon no_data without aborting other months", async () => {
    securitiesRows = [makeSecurityRow({ security_id: "sec-f", ticker_symbol: "TKR-F" })];

    // First polygon call → no_data (empty results); rest → success (default).
    enqueueFetch(() => new Response(JSON.stringify({ results: [] }), { status: 200 }));

    const now = new Date();
    const fromDate = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();

    const result = await backfillMonthlySecuritySnapshotsForward([
      { security_id: "sec-f", fromDate },
    ]);

    expect(result.empty).toBe(1);
    expect(result.filled).toBe(1);
    expect(result.errors).toBe(0);
  });

  test("counts polygon api_error in the errors bucket", async () => {
    securitiesRows = [makeSecurityRow({ security_id: "sec-g", ticker_symbol: "TKR-G" })];

    // Every fetch returns a 200 with a non-JSON body so `response.json()`
    // throws — polygon catches it and returns `api_error`. 200 (not 5xx)
    // avoids fetchWithRetry's exponential backoff (~3s per call).
    mockFetch.mockReset();
    mockFetch.mockImplementation(
      async () => new Response("not json", { status: 200 }) as Response,
    );

    const now = new Date();
    const fromDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const result = await backfillMonthlySecuritySnapshotsForward([
      { security_id: "sec-g", fromDate },
    ]);

    expect(result.errors).toBeGreaterThanOrEqual(1);
    expect(result.filled).toBe(0);
  });

  test("respects maxMonthsPerInvocation cap", async () => {
    securitiesRows = [makeSecurityRow({ security_id: "sec-h", ticker_symbol: "TKR-H" })];

    // 24 months before now — without a cap that'd be 25 polygon calls.
    const now = new Date();
    const fromDate = new Date(now.getFullYear() - 2, now.getMonth(), 1).toISOString();

    const result = await backfillMonthlySecuritySnapshotsForward(
      [{ security_id: "sec-h", fromDate }],
      { maxMonthsPerInvocation: 5 },
    );

    expect(polygonCalls()).toHaveLength(5);
    expect(result.filled).toBe(5);
  });

  test("skips securities with no row in the securities table", async () => {
    securitiesRows = []; // empty SELECT result for the orphan ID

    const result = await backfillMonthlySecuritySnapshotsForward([
      { security_id: "sec-orphan", fromDate: new Date().toISOString() },
    ]);

    expect(result.filled).toBe(0);
    expect(polygonCalls()).toHaveLength(0);
  });
});
