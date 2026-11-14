// The planner is pure; the runner reads and writes `cpi_snapshots` through
// `pg` (leaf-mocked) and calls BLS through `globalThis.fetch` (mocked). No
// API key is set, so the keyless v1 tier applies: 10 years per request.
const originalApiKey = process.env.BLS_API_KEY;
delete process.env.BLS_API_KEY;

import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakePg, restoreLeaves } from "test-helpers";
import type { JSONCpiSnapshot } from "common";

const { pg, mockQuery, resetQueryMocks } = createFakePg();
mock.module("pg", () => pg);

const mockFetch = mock(
  async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> =>
    new Response("{}", { status: 500 }),
);
globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

const { planCpiFetch, refreshCpiSnapshots, CPI_REFRESH_SKIP_WINDOW_HOURS } = await import(
  "./refresh-cpi-snapshots"
);
const { resetBlsRequestBudget, getBlsTier } = await import("server/lib/bls");
const { INFLATION_AVERAGE_YEARS } = await import("server/lib/inflation");

afterAll(() => {
  if (originalApiKey === undefined) delete process.env.BLS_API_KEY;
  else process.env.BLS_API_KEY = originalApiKey;
  restoreLeaves();
});

const NOW = new Date(2026, 10, 14, 12); // 2026-11-14, latest publishable month 2026-10
const HOUR = 60 * 60 * 1000;
const FIRST_YEAR = 2026 - INFLATION_AVERAGE_YEARS - 1;

const month = (year: number, m: number, updated: string | null = null): JSONCpiSnapshot => ({
  series_id: "CUUR0000SA0",
  date: `${year}-${String(m).padStart(2, "0")}-01`,
  value: 100 + (year - 1990) * 3 + m / 10,
  updated,
});

/** One stored month per year across the whole window, through `lastYear`/`lastMonth`. */
const fullHistory = (lastYear: number, lastMonth: number, updated: string | null) => {
  const rows: JSONCpiSnapshot[] = [];
  for (let y = FIRST_YEAR; y < lastYear; y++) rows.push(month(y, 6, updated));
  for (let m = 1; m <= lastMonth; m++) rows.push(month(lastYear, m, updated));
  return rows;
};

const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();

describe("planCpiFetch", () => {
  test("an empty table backfills the whole window in 10-year requests", () => {
    const plan = planCpiFetch([], NOW, 10);
    expect(plan.requests).toEqual([
      [FIRST_YEAR, FIRST_YEAR + 9],
      [FIRST_YEAR + 10, FIRST_YEAR + 19],
      [FIRST_YEAR + 20, FIRST_YEAR + 29],
      [FIRST_YEAR + 30, 2026],
    ]);
    expect(plan.requests.length).toBeLessThanOrEqual(getBlsTier().dailyBudget);
    expect(plan.fresh).toBe(false);
  });

  test("with a registration key the same backfill takes two requests", () => {
    const plan = planCpiFetch([], NOW, 20);
    expect(plan.requests).toEqual([
      [FIRST_YEAR, FIRST_YEAR + 19],
      [FIRST_YEAR + 20, 2026],
    ]);
  });

  test("a current series makes no request at all", () => {
    const plan = planCpiFetch(fullHistory(2026, 10, iso(48 * HOUR)), NOW, 10);
    expect(plan).toEqual({ requests: [], fresh: true, gated: false });
  });

  test("a series one month behind re-requests only the latest year, once the window has passed", () => {
    const plan = planCpiFetch(fullHistory(2026, 9, iso(CPI_REFRESH_SKIP_WINDOW_HOURS * HOUR)), NOW, 10);
    expect(plan).toEqual({ requests: [[2026, 2026]], fresh: false, gated: false });
  });

  test("a series behind but refreshed inside the skip window waits", () => {
    const plan = planCpiFetch(fullHistory(2026, 9, iso(2 * HOUR)), NOW, 10);
    expect(plan).toEqual({ requests: [], fresh: false, gated: true });
  });

  test("in January the refresh reaches back into December's year", () => {
    const january = new Date(2027, 0, 20);
    const rows = fullHistory(2026, 11, new Date(2027, 0, 10).toISOString());
    // Latest stored is 2026-11; 2026-12 is publishable now, so the refresh
    // spans December's year through the current one in a single request.
    const plan = planCpiFetch(rows, january, 10);
    expect(plan.requests).toEqual([[2026, 2027]]);
  });

  test("a partly finished backfill requests only the missing years", () => {
    const rows = fullHistory(2026, 10, iso(HOUR)).filter((r) => {
      const y = Number(r.date.slice(0, 4));
      return y < 2001 || y > 2004;
    });
    const plan = planCpiFetch(rows, NOW, 10);
    expect(plan.requests).toEqual([[2001, 2004]]);
    expect(plan.fresh).toBe(true);
  });

  test("a year with a missing month is never re-requested", () => {
    // October 2025 does not exist at BLS; the rest of 2025 does.
    const rows = fullHistory(2026, 10, iso(48 * HOUR));
    expect(planCpiFetch(rows, NOW, 10).requests).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// refreshCpiSnapshots — runner
// ---------------------------------------------------------------------------

let storedRows: Array<Record<string, unknown>> = [];
const upserts: Array<{ sql: string; values: unknown[] }> = [];
let failUpsert = false;

const toRow = (s: JSONCpiSnapshot) => ({
  cpi_snapshot_id: `${s.series_id}-${s.date.slice(0, 7)}`,
  series_id: s.series_id,
  snapshot_date: s.date,
  index_value: s.value,
  updated: s.updated ?? null,
});

const router = async (sql: string, values?: unknown[]) => {
  if (/^\s*SELECT\s+\*\s+FROM\s+cpi_snapshots/i.test(sql)) {
    return { rows: storedRows, rowCount: storedRows.length };
  }
  if (/^\s*INSERT\s+INTO\s+cpi_snapshots/i.test(sql)) {
    if (failUpsert) throw new Error("db down");
    upserts.push({ sql, values: values ?? [] });
    const tuples = sql.match(/\(CURRENT_TIMESTAMP/g)?.length ?? 0;
    return { rows: new Array(tuples).fill({}), rowCount: tuples };
  }
  return { rows: [], rowCount: 0 };
};

const blsBody = (years: number[], months = 12) => ({
  status: "REQUEST_SUCCEEDED",
  message: [],
  Results: {
    series: [
      {
        seriesID: "CUUR0000SA0",
        data: years.flatMap((year) =>
          Array.from({ length: months }, (_, i) => ({
            year: String(year),
            period: `M${String(i + 1).padStart(2, "0")}`,
            value: (250 + year - 2000 + i / 10).toFixed(3),
          })),
        ),
      },
    ],
  },
});

const echoRequestedYears = async (_url: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body));
  const years: number[] = [];
  for (let y = Number(body.startyear); y <= Number(body.endyear); y++) years.push(y);
  return new Response(JSON.stringify(blsBody(years)));
};

beforeEach(() => {
  resetQueryMocks();
  mockQuery.mockImplementation(router);
  mockFetch.mockReset();
  mockFetch.mockImplementation(echoRequestedYears);
  resetBlsRequestBudget();
  storedRows = [];
  upserts.length = 0;
  failUpsert = false;
});

describe("refreshCpiSnapshots", () => {
  test("backfills an empty table, storing no month later than the current one", async () => {
    const result = await refreshCpiSnapshots(NOW);

    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(result.requests).toBe(4);
    expect(result.errors).toBe(0);
    expect(result.deferred).toBe(0);
    // 31 complete years + January..November of 2026 (December is in the future).
    expect(result.upserted).toBe(31 * 12 + 11);

    const allValues = upserts.flatMap((u) => u.values);
    expect(allValues).toContain("CUUR0000SA0-2026-11");
    expect(allValues).not.toContain("CUUR0000SA0-2026-12");
  });

  test("a current series makes no BLS request", async () => {
    storedRows = fullHistory(2026, 10, iso(48 * HOUR)).map(toRow);
    const result = await refreshCpiSnapshots(NOW);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result).toEqual({
      requests: 0,
      upserted: 0,
      fresh: true,
      gated: false,
      deferred: 0,
      errors: 0,
    });
  });

  test("stops at the daily budget and defers the rest of the plan", async () => {
    const { dailyBudget } = getBlsTier();
    // Spend all but one slot elsewhere in the day.
    const { getCpiSeries } = await import("server/lib/bls");
    for (let i = 0; i < dailyBudget - 1; i++) await getCpiSeries(2026, 2026);
    mockFetch.mockClear();

    const result = await refreshCpiSnapshots(NOW);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.requests).toBe(1);
    expect(result.deferred).toBe(3);
  });

  test("stops for the day when BLS says its own threshold is reached", async () => {
    mockFetch.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            status: "REQUEST_NOT_PROCESSED",
            message: ["daily threshold for total number of requests has been reached"],
          }),
        ),
    );
    const result = await refreshCpiSnapshots(NOW);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.requests).toBe(1);
    expect(result.deferred).toBe(4);
  });

  test("keeps going past a failed chunk and counts the error", async () => {
    mockFetch.mockImplementationOnce(async () => new Response("{}", { status: 502 }));
    const result = await refreshCpiSnapshots(NOW);
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(result.errors).toBe(1);
    expect(result.upserted).toBeGreaterThan(0);
  });

  test("counts a failed write as an error without throwing", async () => {
    failUpsert = true;
    const result = await refreshCpiSnapshots(NOW);
    expect(result.errors).toBe(4);
    expect(result.upserted).toBe(0);
  });
});
