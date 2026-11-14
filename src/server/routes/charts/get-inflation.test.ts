import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakePg, restoreLeaves } from "test-helpers";

let storedRows: Array<Record<string, unknown>> = [];
const { pg, mockQuery, resetQueryMocks } = createFakePg(async (sql: string) => {
  if (/FROM\s+cpi_snapshots/i.test(sql)) return { rows: storedRows, rowCount: storedRows.length };
  return { rows: [], rowCount: 0 };
});
mock.module("pg", () => pg);

// The route must answer from the database alone. Any outbound request — BLS
// or otherwise — would show up here.
const mockFetch = mock(async () => new Response("{}"));
globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

const { getInflationRoute } = await import("./get-inflation");

afterAll(restoreLeaves);

beforeEach(() => {
  resetQueryMocks();
  mockFetch.mockClear();
  storedRows = [];
});

const makeReq = (authenticated = true) =>
  ({
    method: "GET",
    path: "/inflation",
    url: "http://x/api/inflation",
    headers: {},
    query: {},
    body: {},
    session: {
      id: "s-1",
      user: authenticated ? { user_id: "u-1", username: "alice" } : undefined,
      regenerate() {},
      destroy() {},
    },
    ip: "127.0.0.1",
  }) as unknown as Parameters<typeof getInflationRoute.execute>[0];

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
  }) as unknown as Parameters<typeof getInflationRoute.execute>[1];

const row = (date: string, value: number) => ({
  cpi_snapshot_id: `CUUR0000SA0-${date.slice(0, 7)}`,
  series_id: "CUUR0000SA0",
  snapshot_date: date,
  index_value: value,
  updated: null,
});

describe("GET /inflation", () => {
  test("returns the averaged rate from stored CPI rows without calling out", async () => {
    storedRows = [row("1996-09-01", 157.8), row("2026-09-01", 315.6)];
    const result = await getInflationRoute.execute(makeReq(), fakeRes());

    expect(result?.status).toBe("success");
    const body = (result as { body: { year_over_year_inflation: number; from: string; to: string } })
      .body;
    expect(body.year_over_year_inflation).toBeCloseTo(Math.pow(2, 1 / 30), 10);
    expect(body.from).toBe("1996-09");
    expect(body.to).toBe("2026-09");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("answers null while the backfill has not stored enough history", async () => {
    const result = await getInflationRoute.execute(makeReq(), fakeRes());
    expect(result).toEqual({ status: "success", body: null });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("refuses an unauthenticated request before touching the database", async () => {
    const result = await getInflationRoute.execute(makeReq(false), fakeRes());
    expect(result?.status).toBe("failed");
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
