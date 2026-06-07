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

const { getSecuritiesRoute } = await import("./get-securities");

afterAll(restoreLeaves);

beforeEach(() => {
  mockQuery.mockReset();
});

function makeReq(
  opts: { authenticated?: boolean } = {},
): Parameters<typeof getSecuritiesRoute.execute>[0] {
  const authenticated = opts.authenticated ?? true;
  return {
    method: "GET",
    path: "/securities",
    url: "http://x/api/securities",
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
  } as unknown as Parameters<typeof getSecuritiesRoute.execute>[0];
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
  }) as unknown as Parameters<typeof getSecuritiesRoute.execute>[1];

const securityRow = (overrides: Record<string, unknown> = {}) => ({
  security_id: "sec-1",
  name: "Anonymized Asset",
  ticker_symbol: "AAA",
  type: null,
  close_price: null,
  close_price_as_of: null,
  iso_currency_code: null,
  isin: null,
  cusip: null,
  raw: null,
  updated: null,
  ...overrides,
});

describe("GET /api/securities", () => {
  test("rejects unauthenticated requests", async () => {
    const result = await getSecuritiesRoute.execute(
      makeReq({ authenticated: false }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("returns every security row as JSONSecurity", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        securityRow({ security_id: "sec-1", ticker_symbol: "VOO", type: "etf" }),
        securityRow({ security_id: "sec-2", ticker_symbol: "QACDS", type: "cash" }),
        securityRow({ security_id: "sec-3", ticker_symbol: "CUR:USD", type: null }),
      ],
      rowCount: 3,
    });

    const result = await getSecuritiesRoute.execute(makeReq(), fakeRes());

    expect(result?.status).toBe("success");
    expect(result?.body).toHaveLength(3);
    expect(result?.body?.map((s) => s.ticker_symbol)).toEqual(["VOO", "QACDS", "CUR:USD"]);
    expect(result?.body?.map((s) => s.type)).toEqual(["etf", "cash", null]);
  });

  test("issues exactly one SELECT against the securities table (no per-row enrichment)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await getSecuritiesRoute.execute(makeReq(), fakeRes());
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/SELECT/i);
    expect(sql).toMatch(/securities/i);
  });
});
