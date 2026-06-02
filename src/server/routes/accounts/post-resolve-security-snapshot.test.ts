// Per-test-bundle isolation — see scripts/test-bundled/.
//
// `POST /api/resolve-security-snapshot` powers the PerformanceBenchmark
// widget's on-demand benchmark price fetch (#386, #414). Uses the
// leaf-mock pg pattern: every DB call (getSecurity, getSecuritySnapshots,
// upsertSnapshots → securitiesTable / snapshotsTable / pool.query) lands
// on `mockQuery` via a FakePool. A SQL router dispatches by table name.
//
// Polygon: `getLatestClosePriceOnOrBefore` runs against real polygon
// code with `globalThis.fetch` mocked + `POLYGON_API_KEY` set in
// process.env before the bundle imports. `POLYGON_RATE_LIMIT_PER_MIN=0`
// disables the rate gate so tests don't wait on token refills. All
// process-global state (env vars + globalThis.fetch) is snapshotted and
// restored in afterAll so sibling tests in the unified process aren't
// affected.
process.env.POLYGON_API_KEY = "test-key";
process.env.POLYGON_RATE_LIMIT_PER_MIN = "0";

import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { bundleOf } from "test-bundled";
import type { JSONSecurity } from "common";

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.POLYGON_API_KEY;
const originalRateLimit = process.env.POLYGON_RATE_LIMIT_PER_MIN;

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

let lastFetchUrl: string | null = null;
const mockFetch = mock(
  async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> =>
    new Response(JSON.stringify({ results: [] }), { status: 200 }),
);
globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

const { postResolveSecuritySnapshotRoute } = await bundleOf<
  typeof import("./post-resolve-security-snapshot")
>(import.meta.url);

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.POLYGON_API_KEY;
  else process.env.POLYGON_API_KEY = originalApiKey;
  if (originalRateLimit === undefined) delete process.env.POLYGON_RATE_LIMIT_PER_MIN;
  else process.env.POLYGON_RATE_LIMIT_PER_MIN = originalRateLimit;
});

// SQL router: SELECT FROM securities returns staged security rows; SELECT
// FROM snapshots returns staged snapshot rows; the upsert INSERT path can
// be made to reject by setting `upsertShouldThrow`.
let securitiesRows: Array<Record<string, unknown>> = [];
let snapshotsRows: Array<Record<string, unknown>> = [];
let upsertShouldThrow: Error | null = null;

const queryRouter = async (sql: string, _values?: unknown[]) => {
  const isSelect = /^\s*SELECT\b/i.test(sql);
  if (isSelect && /\bFROM\s+securities\b/i.test(sql)) {
    return { rows: securitiesRows, rowCount: securitiesRows.length };
  }
  if (isSelect && /\bFROM\s+snapshots\b/i.test(sql)) {
    return { rows: snapshotsRows, rowCount: snapshotsRows.length };
  }
  if (/\bINSERT\s+INTO\s+snapshots\b/i.test(sql) && upsertShouldThrow) {
    throw upsertShouldThrow;
  }
  return { rows: [], rowCount: 0 };
};

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockImplementation(queryRouter);
  securitiesRows = [];
  snapshotsRows = [];
  upsertShouldThrow = null;

  mockFetch.mockReset();
  lastFetchUrl = null;
  mockFetch.mockImplementation(async (url: string | URL | Request) => {
    lastFetchUrl =
      typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  });
});

/**
 * Stage the next polygon fetch with a custom JSON body or rejection.
 * The route parses `response.json()` then inspects `json.results` /
 * `json.status` / `json.message`.
 */
const setPolygonResponse = (
  body: unknown,
  opts: { jsonRejects?: Error; status?: number } = {},
): void => {
  mockFetch.mockImplementationOnce(async (url): Promise<Response> => {
    lastFetchUrl =
      typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
    return {
      ok: true,
      status: opts.status ?? 200,
      json: async () => {
        if (opts.jsonRejects) throw opts.jsonRejects;
        return body;
      },
    } as unknown as Response;
  });
};

/**
 * Full SecurityModel-valid raw row. SecurityModel.typeChecker validates
 * each field; missing/wrong-typed values throw at model construction.
 */
const securityRow = (overrides: Partial<JSONSecurity> = {}) => ({
  security_id: "sec-1",
  name: "Test Security",
  ticker_symbol: "AAA",
  type: "etf",
  close_price: null,
  close_price_as_of: null,
  iso_currency_code: "USD",
  isin: null,
  cusip: null,
  raw: null,
  updated: null,
  ...overrides,
});

const snapshotRow = (overrides: Record<string, unknown> = {}) => ({
  snapshot_id: "snap-existing",
  snapshot_date: "2026-05-10",
  snapshot_type: "security",
  security_id: "sec-1",
  close_price: 100,
  ...overrides,
});

function makeReq(
  body: unknown,
  opts: { authenticated?: boolean; userId?: string } = {},
): Parameters<typeof postResolveSecuritySnapshotRoute.execute>[0] {
  const authenticated = opts.authenticated ?? true;
  const userId = opts.userId ?? "u-1";
  return {
    method: "POST",
    path: "/resolve-security-snapshot",
    url: "http://x/api/resolve-security-snapshot",
    headers: {},
    query: {},
    body,
    session: {
      id: "s-1",
      user: authenticated ? { user_id: userId, username: "alice" } : undefined,
      regenerate() {},
      destroy() {},
    },
    ip: "127.0.0.1",
  } as unknown as Parameters<typeof postResolveSecuritySnapshotRoute.execute>[0];
}

const fakeRes = () =>
  ({
    statusCode: 200,
    headersSent: false,
    status() {
      return this;
    },
    write() {
      return true;
    },
    end() {},
  }) as unknown as Parameters<typeof postResolveSecuritySnapshotRoute.execute>[1];

describe("POST /api/resolve-security-snapshot — auth + validation", () => {
  test("rejects unauthenticated requests", async () => {
    const result = await postResolveSecuritySnapshotRoute.execute(
      makeReq({ security_id: "sec-1", date: "2026-05-14" }, { authenticated: false }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("rejects when body is missing entirely", async () => {
    const result = await postResolveSecuritySnapshotRoute.execute(
      makeReq(undefined),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
  });

  test("rejects when body is not an object (array)", async () => {
    const result = await postResolveSecuritySnapshotRoute.execute(makeReq([]), fakeRes());
    expect(result?.status).toBe("failed");
  });

  test("rejects when security_id is missing", async () => {
    const result = await postResolveSecuritySnapshotRoute.execute(
      makeReq({ date: "2026-05-14" }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/security_id/);
  });

  test("rejects when security_id is not a string", async () => {
    const result = await postResolveSecuritySnapshotRoute.execute(
      makeReq({ security_id: 123, date: "2026-05-14" }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/security_id/);
  });

  test("rejects when date is missing", async () => {
    const result = await postResolveSecuritySnapshotRoute.execute(
      makeReq({ security_id: "sec-1" }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/date/);
  });

  test("rejects when date doesn't match YYYY-MM-DD prefix", async () => {
    const result = await postResolveSecuritySnapshotRoute.execute(
      makeReq({ security_id: "sec-1", date: "not-a-date" }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/invalid date/i);
  });
});

describe("POST /api/resolve-security-snapshot — security lookup", () => {
  test("returns resolved:false when security is not found", async () => {
    securitiesRows = []; // queryOne returns null
    const result = await postResolveSecuritySnapshotRoute.execute(
      makeReq({ security_id: "missing", date: "2026-05-14" }),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    expect(result?.body?.resolved).toBe(false);
    expect(result?.body?.message).toMatch(/security not found/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("returns cash-equivalent fallback when ticker_symbol is null", async () => {
    securitiesRows = [securityRow({ ticker_symbol: null })];
    const result = await postResolveSecuritySnapshotRoute.execute(
      makeReq({ security_id: "sec-1", date: "2026-05-14" }),
      fakeRes(),
    );
    expect(result?.body?.resolved).toBe(false);
    expect(result?.body?.message).toMatch(/cash-equivalent/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("returns cash-equivalent fallback when ticker starts with 'CUR:'", async () => {
    securitiesRows = [securityRow({ ticker_symbol: "CUR:USD" })];
    const result = await postResolveSecuritySnapshotRoute.execute(
      makeReq({ security_id: "sec-1", date: "2026-05-14" }),
      fakeRes(),
    );
    expect(result?.body?.resolved).toBe(false);
    expect(result?.body?.message).toMatch(/cash-equivalent/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("returns cash-equivalent fallback when security.type === 'cash'", async () => {
    securitiesRows = [securityRow({ ticker_symbol: "USD", type: "cash" })];
    const result = await postResolveSecuritySnapshotRoute.execute(
      makeReq({ security_id: "sec-1", date: "2026-05-14" }),
      fakeRes(),
    );
    expect(result?.body?.resolved).toBe(false);
    expect(result?.body?.message).toMatch(/cash-equivalent/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("POST /api/resolve-security-snapshot — existing snapshot reuse", () => {
  test("reuses an existing snapshot within 7 days and skips the Polygon call", async () => {
    securitiesRows = [securityRow()];
    snapshotsRows = [
      snapshotRow({ snapshot_id: "snap-recent", snapshot_date: "2026-05-12", close_price: 100 }),
    ];
    const result = await postResolveSecuritySnapshotRoute.execute(
      makeReq({ security_id: "sec-1", date: "2026-05-14" }),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    expect(result?.body?.resolved).toBe(true);
    expect(result?.body?.source).toBe("existing");
    expect(result?.body?.snapshot?.snapshot.snapshot_id).toBe("snap-recent");
    expect(result?.body?.snapshot?.security.close_price).toBe(100);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("falls through to Polygon when the nearest snapshot is older than 7 days", async () => {
    securitiesRows = [securityRow({ ticker_symbol: "VOO" })];
    snapshotsRows = [
      // 30 days before request date — outside 7-day proximity window.
      snapshotRow({ snapshot_id: "snap-old", snapshot_date: "2026-04-14", close_price: 100 }),
    ];
    setPolygonResponse({
      results: [{ c: 432.1, t: Date.UTC(2026, 4, 13, 12, 0, 0) }],
    });
    const result = await postResolveSecuritySnapshotRoute.execute(
      makeReq({ security_id: "sec-1", date: "2026-05-14" }),
      fakeRes(),
    );
    expect(result?.body?.resolved).toBe(true);
    expect(result?.body?.source).toBe("polygon");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("falls through to Polygon when the nearest snapshot has null close_price", async () => {
    securitiesRows = [securityRow({ ticker_symbol: "VOO" })];
    snapshotsRows = [
      snapshotRow({ snapshot_id: "snap-null", snapshot_date: "2026-05-12", close_price: null }),
    ];
    setPolygonResponse({
      results: [{ c: 432.1, t: Date.UTC(2026, 4, 13, 12, 0, 0) }],
    });
    const result = await postResolveSecuritySnapshotRoute.execute(
      makeReq({ security_id: "sec-1", date: "2026-05-14" }),
      fakeRes(),
    );
    expect(result?.body?.resolved).toBe(true);
    expect(result?.body?.source).toBe("polygon");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/resolve-security-snapshot — Polygon outcomes", () => {
  test("surfaces no_api_key as 'Market data API is not configured'", async () => {
    const savedKey = process.env.POLYGON_API_KEY;
    process.env.POLYGON_API_KEY = "";
    try {
      securitiesRows = [securityRow()];
      const result = await postResolveSecuritySnapshotRoute.execute(
        makeReq({ security_id: "sec-1", date: "2026-05-14" }),
        fakeRes(),
      );
      expect(result?.body?.resolved).toBe(false);
      expect(result?.body?.reason).toBe("no_api_key");
      expect(result?.body?.message).toBe("Market data API is not configured");
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      process.env.POLYGON_API_KEY = savedKey;
    }
  });

  test("surfaces plan_limit with a plan-range message", async () => {
    securitiesRows = [securityRow()];
    setPolygonResponse({
      status: "NOT_AUTHORIZED",
      message: "Plan doesn't cover this range",
    });
    const result = await postResolveSecuritySnapshotRoute.execute(
      makeReq({ security_id: "sec-1", date: "2026-05-14" }),
      fakeRes(),
    );
    expect(result?.body?.resolved).toBe(false);
    expect(result?.body?.reason).toBe("plan_limit");
    expect(result?.body?.message).toMatch(/plan/i);
  });

  test("surfaces no_data with a ticker- and date-specific message", async () => {
    securitiesRows = [securityRow({ ticker_symbol: "VOO" })];
    setPolygonResponse({ results: [] });
    const result = await postResolveSecuritySnapshotRoute.execute(
      makeReq({ security_id: "sec-1", date: "2026-05-14" }),
      fakeRes(),
    );
    expect(result?.body?.resolved).toBe(false);
    expect(result?.body?.reason).toBe("no_data");
    expect(result?.body?.message).toContain("VOO");
    expect(result?.body?.message).toContain("2026-05-14");
  });

  test("surfaces a generic Polygon api_error with the underlying message", async () => {
    securitiesRows = [securityRow()];
    setPolygonResponse({}, { jsonRejects: new Error("connection reset") });
    const result = await postResolveSecuritySnapshotRoute.execute(
      makeReq({ security_id: "sec-1", date: "2026-05-14" }),
      fakeRes(),
    );
    expect(result?.body?.resolved).toBe(false);
    expect(result?.body?.reason).toBe("api_error");
    expect(result?.body?.message).toMatch(/Polygon error:.*connection reset/);
  });

  test("on Polygon success, upserts a snapshot and returns source: 'polygon'", async () => {
    securitiesRows = [securityRow({ ticker_symbol: "VOO" })];
    setPolygonResponse({
      results: [{ c: 432.1, t: Date.UTC(2026, 4, 13, 12, 0, 0) }],
    });
    const result = await postResolveSecuritySnapshotRoute.execute(
      makeReq({ security_id: "sec-1", date: "2026-05-14" }),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    expect(result?.body?.resolved).toBe(true);
    expect(result?.body?.source).toBe("polygon");
    expect(result?.body?.snapshot?.security.close_price).toBe(432.1);
    expect(result?.body?.snapshot?.security.close_price_as_of).toBe("2026-05-13");
    expect(result?.body?.snapshot?.snapshot.date).toBe("2026-05-13T12:00:00.000Z");
    // Upsert SQL fired — INSERT INTO snapshots ... in the mockQuery log.
    const insertCalls = mockQuery.mock.calls.filter((c) =>
      /\bINSERT\s+INTO\s+snapshots\b/i.test(c[0] as string),
    );
    expect(insertCalls).toHaveLength(1);
  });

  test("when snapshotsTable.upsert rejects, the route still returns resolved:true", async () => {
    // upsertSnapshots wraps each upsert in its own try/catch, so a rejection
    // inside the table call is swallowed and the route returns the freshly
    // fetched Polygon price for the current render — the "snapshot persists
    // in memory even if disk write fails" contract.
    securitiesRows = [securityRow({ ticker_symbol: "VOO" })];
    setPolygonResponse({
      results: [{ c: 100, t: Date.UTC(2026, 4, 13, 12, 0, 0) }],
    });
    upsertShouldThrow = new Error("write failed");
    const result = await postResolveSecuritySnapshotRoute.execute(
      makeReq({ security_id: "sec-1", date: "2026-05-14" }),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    expect(result?.body?.resolved).toBe(true);
    expect(result?.body?.source).toBe("polygon");
    expect(result?.body?.snapshot?.security.close_price).toBe(100);
  });
});

describe("POST /api/resolve-security-snapshot — future-date clamping", () => {
  test("clamps a future date to today before calling Polygon", async () => {
    securitiesRows = [securityRow({ ticker_symbol: "VOO" })];
    setPolygonResponse({ results: [] });

    // 30 years in the future — regardless of when this test runs, todayStr
    // compares less and triggers the clamp.
    const todayStr = new Date().toISOString().slice(0, 10);
    const futureDate = "2055-01-01";

    await postResolveSecuritySnapshotRoute.execute(
      makeReq({ security_id: "sec-1", date: futureDate }),
      fakeRes(),
    );

    // The route bakes effectiveDateStr into the Polygon URL as the `to`
    // parameter — `/range/1/day/<from>/<to>?apiKey=...`.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(lastFetchUrl).toMatch(new RegExp(`/${todayStr}\\?apiKey=`));
    expect(lastFetchUrl).not.toContain(futureDate);

    // And the SQL endDate param for getSecuritySnapshots matches todayStr.
    const snapshotSelects = mockQuery.mock.calls.filter(
      (c) =>
        /^\s*SELECT[\s\S]*FROM\s+snapshots\b/i.test(c[0] as string) &&
        (c[1] as unknown[] | undefined)?.includes(todayStr),
    );
    expect(snapshotSelects).toHaveLength(1);
  });
});
