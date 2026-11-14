//
// `refreshActiveSecuritySnapshots` reads holdings + securities from
// `pool.query` / `searchSecuritiesById` and calls
// `polygon.getLatestClosePriceOnOrBefore` for each non-cash security.
// The bundle inlines polygon, so we leaf-mock the SQL driver for the DB layer and
// `globalThis.fetch` for polygon. The polygon module reads
// `process.env.POLYGON_API_KEY` / `POLYGON_RATE_LIMIT_PER_MIN` once at
// module load — set them BEFORE importing so:
//   1. polygon doesn't short-circuit `no_api_key`.
//   2. The rate-limit queue runs at capacity=0 (no throttling).
//
// The fetch override + env writes are process-global; `restoreLeaves` puts
// both back from the preload's snapshots, so this file doesn't leak into
// other suites.

process.env.POLYGON_API_KEY = "test-key";
process.env.POLYGON_RATE_LIMIT_PER_MIN = "0";

import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { BENCHMARK_HISTORY_THROUGH } from "common/constants";
import { getDateString } from "common";
import { createFakeSql, restoreLeaves } from "test-helpers";

const { driver, mockUnsafe, resetSqlMocks } = createFakeSql();

mock.module("../postgres/sql-driver", () => driver);

const mockFetch = mock(
  async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> =>
    new Response(JSON.stringify({ results: [{ c: 100, t: Date.UTC(2026, 5, 10) }] }), {
      status: 200,
    }),
);
globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

const { refreshActiveSecuritySnapshots, BENCHMARK_SECURITY_ID } = await import("./refresh-security-snapshots");
const { clearPriceCache } = await import("server/lib/polygon");
const { clearYahooCache } = await import("server/lib/yahoo");

afterAll(restoreLeaves);

// SQL router. Each test stages:
//   - holdingsRows  → DISTINCT security_id query result
//   - securitiesRows → per-id securities row (one queryOne per id in searchSecuritiesById)
//   - recentBySecurity → cadence-gate set; security_ids in the set are
//     treated as having a snapshot whose `updated` is within the window.
//     It starts with the benchmark's own row, so a test that isn't about
//     the benchmark sees it as fresh and makes no call for it.
let holdingsRows: Array<{ security_id: string }> = [];
let securitiesRows: Array<Record<string, unknown>> = [];
let recentBySecurity = new Set<string>();
let latestSnapshotDate: Record<string, string> = {};
const upsertCalls: Array<{ sql: string; values: unknown[] }> = [];
const securityInserts: Array<Record<string, unknown>> = [];

const queryRouter = async (sql: string, values?: unknown[]) => {
  const params = (values ?? []) as unknown[];

  if (/SELECT\s+DISTINCT\s+security_id\s+FROM\s+holdings/i.test(sql)) {
    return { rows: holdingsRows, rowCount: holdingsRows.length };
  }

  if (/SELECT\s+\*\s+FROM\s+securities\s+WHERE\s+ticker_symbol/i.test(sql)) {
    const rows = securitiesRows
      .filter((r) => r.ticker_symbol === params[0])
      .sort((a, b) => String(b.updated ?? "").localeCompare(String(a.updated ?? "")));
    return { rows, rowCount: rows.length };
  }

  if (/INSERT\s+INTO\s+securities/i.test(sql)) {
    // `updated` is CURRENT_TIMESTAMP, not a parameter.
    const columns = /\(([^)]*)\)\s*VALUES/i
      .exec(sql)![1]
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c !== "updated");
    const row = Object.fromEntries(columns.map((c, i) => [c, params[i]]));
    securityInserts.push(row);
    securitiesRows = [...securitiesRows, securityRow(row)];
    return { rows: [row], rowCount: 1 };
  }

  if (/SELECT\s+\*\s+FROM\s+securities/i.test(sql)) {
    const wantId = params[0];
    const row = securitiesRows.find((r) => r.security_id === wantId);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }

  if (/MAX\(snapshot_date\)/i.test(sql)) {
    return { rows: [{ date: latestSnapshotDate[params[0] as string] ?? null }], rowCount: 1 };
  }

  // Cadence-gate probe — `… updated > NOW() - INTERVAL 'N hours' …`.
  // Batched: one query for the whole pass, `$1` an array of security
  // ids; the rows returned are the ids with a recent snapshot.
  if (/updated\s*>\s*NOW\(\)\s*-\s*INTERVAL/i.test(sql)) {
    const ids = (Array.isArray(params[0]) ? params[0] : [params[0]]) as string[];
    const rows = ids.filter((id) => recentBySecurity.has(id)).map((security_id) => ({ security_id }));
    return { rows, rowCount: rows.length };
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

/** A fixed pass time for the range tests, about a week after the static history ends. */
const NOW = new Date("2026-10-20T12:00:00Z");
/** The pass's date as the job reads it (local time), and the days around it. */
const passDay = (offset: number) => {
  const date = new Date(`${getDateString(NOW)}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};

beforeEach(() => {
  clearPriceCache();
  clearYahooCache();
  resetSqlMocks();
  mockUnsafe.mockImplementation(queryRouter);
  mockFetch.mockReset();
  mockFetch.mockImplementation(
    async () =>
      new Response(JSON.stringify({ results: [{ c: 100, t: Date.UTC(2026, 5, 10) }] }), {
        status: 200,
      }),
  );
  holdingsRows = [];
  securitiesRows = [];
  recentBySecurity = new Set([BENCHMARK_SECURITY_ID]);
  latestSnapshotDate = {};
  upsertCalls.length = 0;
  securityInserts.length = 0;
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
  test("no holdings → no polygon calls; only the benchmark is looked at", async () => {
    const r = await refreshActiveSecuritySnapshots();
    expect(r).toEqual({ refreshed: 0, fresh: 1, cash: 0, empty: 0, errors: 0 });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("one referenced ticker → polygon called, snapshot upserted", async () => {
    holdingsRows = [{ security_id: "sec-1" }];
    securitiesRows = [securityRow({ security_id: "sec-1", ticker_symbol: "AAPL" })];

    const r = await refreshActiveSecuritySnapshots();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(upsertCalls).toHaveLength(1);
    expect(r.refreshed).toBe(1);
    // The benchmark.
    expect(r.fresh).toBe(1);
    expect(r.cash).toBe(0);
    // The upserted row's snapshot_id derives from polygon's returned
    // tradingDate (Date.UTC(2026, 5, 10) → 2026-06-10 → 20260610),
    // not "today" — proves idempotency anchors on tradingDate.
    expect(upsertCalls[0].values.some((v) => String(v) === "sec-1-20260610")).toBe(true);
  });

  test("cryptocurrency security is fetched from polygon's crypto namespace, never the bare equity ticker", async () => {
    holdingsRows = [{ security_id: "sec-btc" }];
    securitiesRows = [
      securityRow({ security_id: "sec-btc", ticker_symbol: "BTC", type: "cryptocurrency" }),
    ];

    const r = await refreshActiveSecuritySnapshots();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = String(mockFetch.mock.calls[0][0]);
    expect(url).toContain("/v2/aggs/ticker/X:BTCUSD/range/1/day/");
    expect(url).not.toContain("/v2/aggs/ticker/BTC/");
    expect(upsertCalls).toHaveLength(1);
    expect(r.refreshed).toBe(1);
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

  test("cadence gate skips polygon when a recent snapshot exists for this security", async () => {
    // Steady-state hourly cycle: the previous run wrote a snapshot
    // less than the skip window ago. Polygon must NOT be called.
    // Without this gate, the cron would burn N polygon calls every
    // hour even when nothing needs refreshing.
    holdingsRows = [{ security_id: "sec-1" }];
    securitiesRows = [securityRow({ security_id: "sec-1", ticker_symbol: "VOO" })];
    recentBySecurity.add("sec-1");

    const r = await refreshActiveSecuritySnapshots();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(upsertCalls).toHaveLength(0);
    expect(r.fresh).toBe(1);
    expect(r.refreshed).toBe(0);
  });

  test("cadence-gate query uses `updated > NOW() - INTERVAL` (not snapshot_date) — survives weekends without re-fetching", async () => {
    // Pin the SQL shape so the gate semantics can't silently regress
    // to a snapshot_date check (which would erroneously force a
    // polygon call every Saturday/Sunday/holiday when no new trading
    // day has landed but the previous run's snapshot looks "old").
    holdingsRows = [{ security_id: "sec-1" }];
    securitiesRows = [securityRow({ security_id: "sec-1", ticker_symbol: "VOO" })];
    await refreshActiveSecuritySnapshots();
    const gateCall = mockUnsafe.mock.calls.find((c) =>
      /updated\s*>\s*NOW\(\)\s*-\s*INTERVAL/i.test(c[0] as string),
    );
    expect(gateCall).toBeDefined();
    expect(gateCall![0]).toMatch(/snapshot_type\s*=\s*'security'/i);
  });

  test("cadence gate is one batched query for N fresh securities, not N queries", async () => {
    // Steady state at scale: 5 held securities, all fresh. The old
    // per-security loop paid 5 gate round trips (plus the benchmark's);
    // the hoisted gate pays exactly 1.
    const ids = ["sec-1", "sec-2", "sec-3", "sec-4", "sec-5"];
    holdingsRows = ids.map((security_id) => ({ security_id }));
    securitiesRows = ids.map((security_id, i) =>
      securityRow({ security_id, ticker_symbol: `TICK${i}` }),
    );
    for (const id of ids) recentBySecurity.add(id);

    const r = await refreshActiveSecuritySnapshots();

    const gateCalls = mockUnsafe.mock.calls.filter((c) =>
      /updated\s*>\s*NOW\(\)\s*-\s*INTERVAL/i.test(c[0] as string),
    );
    expect(gateCalls).toHaveLength(1);
    const gateIds = (gateCalls[0][1] as unknown[])?.[0] as string[];
    expect(gateIds.sort()).toEqual([...ids, BENCHMARK_SECURITY_ID].sort());
    expect(mockFetch).not.toHaveBeenCalled();
    expect(r).toEqual({ refreshed: 0, fresh: 6, cash: 0, empty: 0, errors: 0 });
  });

  test("cash securities add no cadence-gate ids — the batched query covers only gate-eligible rows", async () => {
    holdingsRows = [{ security_id: "cash-1" }];
    securitiesRows = [
      securityRow({ security_id: "cash-1", ticker_symbol: "CUR:USD", type: "cash" }),
    ];
    const r = await refreshActiveSecuritySnapshots();
    const gateCalls = mockUnsafe.mock.calls.filter((c) =>
      /updated\s*>\s*NOW\(\)\s*-\s*INTERVAL/i.test(c[0] as string),
    );
    // One query, for the benchmark row the pass creates — the cash id
    // is not among its parameters.
    expect(gateCalls).toHaveLength(1);
    const gateIds = (gateCalls[0][1] as unknown[])?.[0] as string[];
    expect(gateIds).toEqual([BENCHMARK_SECURITY_ID]);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(r.cash).toBe(1);
    expect(r.fresh).toBe(1);
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
    mockUnsafe.mockImplementation(async (sql: string, values?: unknown[]) => {
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
    recentBySecurity.add("sec-fresh");

    const r = await refreshActiveSecuritySnapshots();
    expect(r.cash).toBe(1);
    expect(r.fresh).toBe(1);
    expect(r.refreshed).toBe(1);
    expect(upsertCalls).toHaveLength(1);
    // sec-fresh hit the cadence gate; only sec-new should have called polygon.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("tickerless securities skipped (no polygon call, no error)", async () => {
    holdingsRows = [{ security_id: "sec-no-ticker" }];
    securitiesRows = [securityRow({ security_id: "sec-no-ticker", ticker_symbol: null })];
    const r = await refreshActiveSecuritySnapshots();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(r).toEqual({ refreshed: 0, fresh: 1, cash: 0, empty: 0, errors: 0 });
  });

  test("cadence gate is per-security: skipping sec-a does not skip sec-b", async () => {
    holdingsRows = [{ security_id: "sec-a" }, { security_id: "sec-b" }];
    securitiesRows = [
      securityRow({ security_id: "sec-a", ticker_symbol: "AAPL" }),
      securityRow({ security_id: "sec-b", ticker_symbol: "MSFT" }),
    ];
    recentBySecurity.add("sec-a");

    const r = await refreshActiveSecuritySnapshots();
    // sec-a and the benchmark.
    expect(r.fresh).toBe(2);
    expect(r.refreshed).toBe(1);
    expect(upsertCalls).toHaveLength(1);
  });
  test("the benchmark is refreshed though no one holds it, on a security row written for it", async () => {
    recentBySecurity = new Set();

    const r = await refreshActiveSecuritySnapshots();

    expect(securityInserts).toEqual([
      expect.objectContaining({ security_id: BENCHMARK_SECURITY_ID, ticker_symbol: "VOO", type: "etf" }),
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toContain("/v2/aggs/ticker/VOO/");
    expect(upsertCalls.some((c) => c.values.some((v) => String(v) === `${BENCHMARK_SECURITY_ID}-20260610`))).toBe(true);
    expect(r).toEqual({ refreshed: 1, fresh: 0, cash: 0, empty: 0, errors: 0 });
  });

  test("an existing row for the benchmark's ticker is used, not a new one", async () => {
    recentBySecurity = new Set();
    securitiesRows = [securityRow({ security_id: "provider-voo", ticker_symbol: "VOO", type: "etf" })];

    const r = await refreshActiveSecuritySnapshots();

    expect(securityInserts).toHaveLength(0);
    expect(upsertCalls.some((c) => c.values.some((v) => String(v) === "provider-voo-20260610"))).toBe(true);
    expect(r.refreshed).toBe(1);
  });

  test("a held benchmark is refreshed once, not twice", async () => {
    recentBySecurity = new Set();
    holdingsRows = [{ security_id: "provider-voo" }];
    securitiesRows = [securityRow({ security_id: "provider-voo", ticker_symbol: "VOO", type: "etf" })];

    const r = await refreshActiveSecuritySnapshots();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(r.refreshed).toBe(1);
  });

  test("a cash row carrying the benchmark's ticker isn't taken for it", async () => {
    recentBySecurity = new Set();
    securitiesRows = [securityRow({ security_id: "cash-voo", ticker_symbol: "VOO", type: "cash" })];

    await refreshActiveSecuritySnapshots();

    expect(securityInserts).toEqual([expect.objectContaining({ security_id: BENCHMARK_SECURITY_ID })]);
  });
  test("of several rows with the benchmark's ticker, the most recently updated is used", async () => {
    recentBySecurity = new Set();
    securitiesRows = [
      securityRow({ security_id: "older-voo", ticker_symbol: "VOO", type: "etf", updated: "2026-01-01T00:00:00Z" }),
      securityRow({ security_id: "newer-voo", ticker_symbol: "VOO", type: "etf", updated: "2026-10-01T00:00:00Z" }),
    ];

    await refreshActiveSecuritySnapshots();

    const written = upsertCalls.flatMap((c) => c.values.map(String));
    expect(written).toContain("newer-voo-20260610");
    expect(written).not.toContain("older-voo-20260610");
  });

  test("the benchmark gets every trading day since its last snapshot, from one range request", async () => {
    recentBySecurity = new Set();
    latestSnapshotDate = { [BENCHMARK_SECURITY_ID]: "2026-10-05" };
    setPolygonResponse({
      results: [6, 7, 8].map((day) => ({ c: 700 + day, t: Date.UTC(2026, 9, day) })),
    });

    const r = await refreshActiveSecuritySnapshots(NOW);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toContain(
      `/v2/aggs/ticker/VOO/range/1/day/2026-10-06/${passDay(-1)}?`,
    );
    const written = upsertCalls.flatMap((c) => c.values.map(String));
    for (const day of ["20261006", "20261007", "20261008"]) expect(written).toContain(`${BENCHMARK_SECURITY_ID}-${day}`);
    expect(r).toEqual({ refreshed: 1, fresh: 0, cash: 0, empty: 0, errors: 0 });
  });

  test("a benchmark with no snapshot is filled from the day after the static history ends", async () => {
    recentBySecurity = new Set();

    await refreshActiveSecuritySnapshots(NOW);

    const dayAfter = new Date(`${BENCHMARK_HISTORY_THROUGH}T12:00:00Z`);
    dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
    expect(String(mockFetch.mock.calls[0][0])).toContain(
      `/range/1/day/${dayAfter.toISOString().slice(0, 10)}/${passDay(-1)}?`,
    );
  });

  test("a benchmark already filled through yesterday asks only for its latest close", async () => {
    recentBySecurity = new Set();
    latestSnapshotDate = { [BENCHMARK_SECURITY_ID]: passDay(-1) };

    const r = await refreshActiveSecuritySnapshots(NOW);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toContain(`/range/1/day/${passDay(-7)}/${passDay(0)}?`);
    expect(r.refreshed).toBe(1);
  });

  test("a single settled day to fill is asked for as a one-day range", async () => {
    recentBySecurity = new Set();
    latestSnapshotDate = { [BENCHMARK_SECURITY_ID]: passDay(-2) };

    await refreshActiveSecuritySnapshots(NOW);

    expect(String(mockFetch.mock.calls[0][0])).toContain(`/range/1/day/${passDay(-1)}/${passDay(-1)}?`);
  });

  test("an empty range still writes the benchmark's latest close", async () => {
    recentBySecurity = new Set();
    latestSnapshotDate = { [BENCHMARK_SECURITY_ID]: "2026-10-05" };
    setPolygonResponse({ results: [] });

    const r = await refreshActiveSecuritySnapshots(NOW);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(upsertCalls.flatMap((c) => c.values.map(String))).toContain(`${BENCHMARK_SECURITY_ID}-20260610`);
    expect(r.refreshed).toBe(1);
  });

  test("a range the server fails on writes nothing, so the next pass asks for the whole range again", async () => {
    recentBySecurity = new Set();
    latestSnapshotDate = { [BENCHMARK_SECURITY_ID]: "2026-10-05" };
    mockFetch.mockImplementation(async () => new Response("unavailable", { status: 503 }));

    const r = await refreshActiveSecuritySnapshots(NOW);

    expect(mockFetch.mock.calls.every((c) => String(c[0]).includes(`/range/1/day/2026-10-06/${passDay(-1)}?`))).toBe(true);
    expect(upsertCalls).toHaveLength(0);
    expect(r.errors).toBe(1);
  });

  test("a range Polygon refuses for the plan writes the latest close", async () => {
    recentBySecurity = new Set();
    latestSnapshotDate = { [BENCHMARK_SECURITY_ID]: "2026-10-05" };
    setPolygonResponse({ status: "NOT_AUTHORIZED", message: "out of plan" });

    const r = await refreshActiveSecuritySnapshots(NOW);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(upsertCalls.flatMap((c) => c.values.map(String))).toContain(`${BENCHMARK_SECURITY_ID}-20260610`);
    expect(r.refreshed).toBe(1);
  });

  test("a held security other than the benchmark asks only for its latest close", async () => {
    holdingsRows = [{ security_id: "sec-1" }];
    securitiesRows = [securityRow({ security_id: "sec-1", ticker_symbol: "AAPL" })];
    latestSnapshotDate = { "sec-1": "2026-01-05" };

    await refreshActiveSecuritySnapshots();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockUnsafe.mock.calls.some((c) => /MAX\(snapshot_date\)/i.test(String(c[0])) && (c[1] as unknown[])?.[0] === "sec-1")).toBe(false);
    expect(String(mockFetch.mock.calls[0][0])).not.toContain("/range/1/day/2026-01-06/");
  });

  test("the static history ends on the date the job fills from", () => {
    const csv = readFileSync(
      resolve(import.meta.dir, "../../../client/public/static-data/voo_price_history.csv"),
      "utf8",
    ).trim();
    expect(csv.slice(csv.lastIndexOf("\n") + 1).split(",")[0]).toBe(BENCHMARK_HISTORY_THROUGH);
  });
});
