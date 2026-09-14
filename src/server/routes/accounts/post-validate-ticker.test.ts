//
// `POST /api/validate-ticker` is the one authenticated route that feeds a
// user-supplied string straight into the process-wide Polygon rate gate, so
// these tests pin the three things that keep one caller off everybody else's
// slots: the charset gate, the securities-table short-circuit, and the
// per-user cap. Leaf-mock pg pattern — every DB call lands on `mockQuery`
// via a FakePool, routed by table name. Polygon runs as real code with
// `globalThis.fetch` mocked.
process.env.POLYGON_API_KEY = "test-key";
process.env.POLYGON_RATE_LIMIT_PER_MIN = "0";

import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakePg, restoreLeaves } from "test-helpers";

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.POLYGON_API_KEY;
const originalRateLimit = process.env.POLYGON_RATE_LIMIT_PER_MIN;

const { pg, mockQuery, resetQueryMocks } = createFakePg();

mock.module("pg", () => pg);

const mockFetch = mock(
  async (): Promise<Response> => new Response(JSON.stringify({}), { status: 200 }),
);
globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

const { postValidateTickerRoute } = await import("./post-validate-ticker");
const { validateTickerRateLimiter } = await import("server/lib/rate-limit");
const { clearPriceCache, polygonQueue } = await import("server/lib/polygon");

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.POLYGON_API_KEY;
  else process.env.POLYGON_API_KEY = originalApiKey;
  if (originalRateLimit === undefined) delete process.env.POLYGON_RATE_LIMIT_PER_MIN;
  else process.env.POLYGON_RATE_LIMIT_PER_MIN = originalRateLimit;
  restoreLeaves();
});

// Rate-limit records live in a process-global Map, so every test takes a
// fresh user id rather than trying to unwind the previous one's counters.
let userSeq = 0;
const nextUser = () => `u-validate-ticker-${++userSeq}`;

let securitiesRows: Array<Record<string, unknown>> = [];

const queryRouter = async (sql: string) => {
  if (/^\s*SELECT\b/i.test(sql) && /\bFROM\s+securities\b/i.test(sql)) {
    return { rows: securitiesRows, rowCount: securitiesRows.length };
  }
  return { rows: [], rowCount: 0 };
};

beforeEach(() => {
  resetQueryMocks();
  mockQuery.mockImplementation(queryRouter);
  securitiesRows = [];
  clearPriceCache();
  polygonQueue.reset();
  mockFetch.mockReset();
  // Empty `results` is Polygon's answer for a symbol it does not know.
  mockFetch.mockImplementation(
    async () =>
      ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response,
  );
});

const securityRow = (overrides: Record<string, unknown> = {}) => ({
  security_id: "sec-1",
  name: "Test Security",
  ticker_symbol: "AAPL",
  type: "equity",
  close_price: 100,
  close_price_as_of: null,
  iso_currency_code: "USD",
  isin: null,
  cusip: null,
  raw: null,
  updated: null,
  ...overrides,
});

function makeReq(
  body: unknown,
  opts: { authenticated?: boolean; userId?: string } = {},
): Parameters<typeof postValidateTickerRoute.execute>[0] {
  const authenticated = opts.authenticated ?? true;
  return {
    method: "POST",
    path: "/validate-ticker",
    url: "http://x/api/validate-ticker",
    headers: {},
    query: {},
    body,
    session: {
      id: "s-1",
      user: authenticated ? { user_id: opts.userId ?? nextUser(), username: "alice" } : undefined,
      regenerate() {},
      destroy() {},
    },
    ip: "127.0.0.1",
  } as unknown as Parameters<typeof postValidateTickerRoute.execute>[0];
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
  }) as unknown as Parameters<typeof postValidateTickerRoute.execute>[1];

const post = (body: unknown, opts?: { authenticated?: boolean; userId?: string }) =>
  postValidateTickerRoute.execute(makeReq(body, opts), fakeRes());

describe("POST /api/validate-ticker — auth and input gate", () => {
  test("rejects unauthenticated requests", async () => {
    const result = await post({ ticker_symbol: "AAPL" }, { authenticated: false });
    expect(result?.status).toBe("failed");
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("rejects a missing ticker_symbol before any lookup", async () => {
    const result = await post({});
    expect(result?.status).toBe("failed");
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("rejects a symbol carrying URL punctuation before any lookup", async () => {
    for (const ticker_symbol of ["AAPL?apiKey=x", "AAPL#f", "A/B", "A".repeat(17)]) {
      const result = await post({ ticker_symbol });
      expect(result?.status).toBe("failed");
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("normalizes case and whitespace before the securities lookup", async () => {
    securitiesRows = [securityRow()];
    const result = await post({ ticker_symbol: "  aapl  " });

    expect(result?.status).toBe("success");
    expect(result?.body?.valid).toBe(true);
    const values = mockQuery.mock.calls[0]?.[1] as unknown[];
    expect(values).toContain("AAPL");
  });
});

describe("POST /api/validate-ticker — per-user cap on the shared Polygon gate", () => {
  test("a symbol already in the securities table never reaches Polygon or the cap", async () => {
    securitiesRows = [securityRow()];
    const userId = nextUser();

    for (let i = 0; i < 30; i++) {
      const result = await post({ ticker_symbol: "AAPL" }, { userId });
      expect(result?.status).toBe("success");
      expect(result?.body?.valid).toBe(true);
    }

    expect(mockFetch).not.toHaveBeenCalled();
    expect(validateTickerRateLimiter.isLimited(userId)).toBe(false);
  });

  test("sheds the 11th novel lookup in a minute as a failure, not as an invalid ticker", async () => {
    const userId = nextUser();

    for (let i = 0; i < 10; i++) {
      const result = await post({ ticker_symbol: `NOPE${i}` }, { userId });
      expect(result?.status).toBe("success");
      expect(result?.body?.valid).toBe(false);
    }

    const shed = await post({ ticker_symbol: "NOPE10" }, { userId });
    expect(shed?.status).toBe("failed");
    expect(shed?.message).toMatch(/too many/i);
  });

  test("caps each caller separately", async () => {
    const noisy = nextUser();
    const bystander = nextUser();

    for (let i = 0; i < 11; i++) await post({ ticker_symbol: `NOPE${i}` }, { userId: noisy });
    expect(validateTickerRateLimiter.isLimited(noisy)).toBe(true);

    const result = await post({ ticker_symbol: "MSFT" }, { userId: bystander });
    expect(result?.status).toBe("success");
    expect(validateTickerRateLimiter.isLimited(bystander)).toBe(false);
  });

  test("a repeated unknown symbol costs one Polygon call, not one per submission", async () => {
    const userId = nextUser();

    for (let i = 0; i < 5; i++) await post({ ticker_symbol: "NOSUCHTICKER" }, { userId });

    // Two endpoints — ticker detail and close price — on the first submission
    // only; every repeat is answered from the empty-result memo.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe("POST /api/validate-ticker — outcomes", () => {
  test("reports an unknown symbol as invalid", async () => {
    const result = await post({ ticker_symbol: "NOSUCHTICKER" });
    expect(result?.status).toBe("success");
    expect(result?.body?.valid).toBe(false);
    expect(result?.body?.message).toMatch(/not found or invalid/i);
  });

  test("returns the security for a symbol Polygon knows", async () => {
    mockFetch.mockImplementation(
      async (...args: unknown[]) =>
        ({
          ok: true,
          status: 200,
          json: async () =>
            String(args[0]).includes("/v3/reference/tickers/")
              ? { results: { name: "Microsoft Corp", currency_name: "usd" } }
              : { results: [{ c: 402.5 }] },
        }) as unknown as Response,
    );

    const result = await post({ ticker_symbol: "MSFT", save: false });

    expect(result?.status).toBe("success");
    expect(result?.body?.valid).toBe(true);
    expect(result?.body?.security?.name).toBe("Microsoft Corp");
    expect(result?.body?.security?.ticker_symbol).toBe("MSFT");
    expect(result?.body?.security?.close_price).toBe(402.5);
  });

  test("a lookup shed by the Polygon gate fails rather than calling the symbol invalid", async () => {
    process.env.POLYGON_RATE_LIMIT_PER_MIN = "1";
    polygonQueue.reset();
    try {
      mockFetch.mockImplementation(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({ results: { name: "Apple", currency_name: "usd" } }),
          }) as unknown as Response,
      );

      // Something else already holds the minute's only slot, so both of the
      // route's lookups run out their budget.
      await polygonQueue.add(async () => undefined);

      const result = await post({ ticker_symbol: "AAPL", save: false });

      expect(result?.status).toBe("failed");
      expect(result?.message).toMatch(/busy/i);
    } finally {
      process.env.POLYGON_RATE_LIMIT_PER_MIN = "0";
      polygonQueue.reset();
    }
  });
});
