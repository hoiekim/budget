// Polygon runs against real module code with `globalThis.fetch` mocked and
// the rate gate disabled, so the per-user cap is exercised without waiting on
// token refills. Set before the bundle imports.
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
  async (): Promise<Response> =>
    ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response,
);
globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

const { postHoldingSnapshotRoute } = await import("./post-holding-snapshot");

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.POLYGON_API_KEY;
  else process.env.POLYGON_API_KEY = originalApiKey;
  if (originalRateLimit === undefined) delete process.env.POLYGON_RATE_LIMIT_PER_MIN;
  else process.env.POLYGON_RATE_LIMIT_PER_MIN = originalRateLimit;
  restoreLeaves();
});

// Every nullable column has to be present as `null` — AccountModel's
// typeChecker accepts null and rejects undefined.
const ACCOUNT_NULLABLE = [
  "name",
  "type",
  "subtype",
  "balances_available",
  "balances_current",
  "balances_limit",
  "balances_iso_currency_code",
  "custom_name",
  "hide",
  "archived",
  "label_budget_id",
  "graph_options_use_snapshots",
  "graph_options_use_holding_snapshots",
  "graph_options_use_transactions",
  "raw",
  "updated",
  "is_deleted",
];

let accountRow: Record<string, unknown> | null = null;

const queryRouter = async (sql: string) => {
  const isSelect = /^\s*SELECT\b/i.test(sql);
  if (isSelect && /\bFROM\s+accounts\b/i.test(sql)) {
    return accountRow ? { rows: [accountRow], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  return { rows: [], rowCount: 0 };
};

beforeEach(() => {
  resetQueryMocks();
  mockQuery.mockImplementation(queryRouter);
  accountRow = null;
  mockFetch.mockReset();
  mockFetch.mockImplementation(
    async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response,
  );
});

function makeReq(body: unknown, userId?: string) {
  return {
    method: "POST",
    path: "/snapshots/holding",
    url: "http://x/api/snapshots/holding",
    headers: {},
    query: {},
    body,
    session: {
      id: "s-1",
      user: userId ? { user_id: userId, username: "test" } : undefined,
      regenerate() {},
      destroy() {},
    },
    ip: "127.0.0.1",
  } as unknown as Parameters<typeof postHoldingSnapshotRoute.execute>[0];
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
  }) as unknown as Parameters<typeof postHoldingSnapshotRoute.execute>[1];

describe("post-holding-snapshot validation", () => {
  test("rejects unauthenticated requests", async () => {
    const req = makeReq({ account_id: "a-1", ticker_symbol: "VOO", quantity: 10 });
    const result = await postHoldingSnapshotRoute.execute(req, fakeRes());
    expect(result).toBeTruthy();
    expect(result!.status).toBe("failed");
    expect(result!.message).toMatch(/not authenticated/i);
  });

  test("rejects non-object body", async () => {
    const req = makeReq("not-an-object", "u-1");
    const result = await postHoldingSnapshotRoute.execute(req, fakeRes());
    expect(result).toBeTruthy();
    expect(result!.status).toBe("failed");
  });

  test("rejects missing account_id in create mode", async () => {
    const req = makeReq({ ticker_symbol: "VOO", quantity: 10 }, "u-1");
    const result = await postHoldingSnapshotRoute.execute(req, fakeRes());
    expect(result).toBeTruthy();
    expect(result!.status).toBe("failed");
    expect(result!.message).toMatch(/account_id/i);
  });

  test("rejects missing ticker_symbol in create mode", async () => {
    const req = makeReq({ account_id: "a-1", quantity: 10 }, "u-1");
    const result = await postHoldingSnapshotRoute.execute(req, fakeRes());
    expect(result).toBeTruthy();
    expect(result!.status).toBe("failed");
    expect(result!.message).toMatch(/ticker_symbol/i);
  });

  test("rejects missing quantity in create mode", async () => {
    const req = makeReq({ account_id: "a-1", ticker_symbol: "VOO" }, "u-1");
    const result = await postHoldingSnapshotRoute.execute(req, fakeRes());
    expect(result).toBeTruthy();
    expect(result!.status).toBe("failed");
    expect(result!.message).toMatch(/quantity/i);
  });

  test("rejects null quantity in create mode", async () => {
    const req = makeReq(
      { account_id: "a-1", ticker_symbol: "VOO", quantity: null },
      "u-1",
    );
    const result = await postHoldingSnapshotRoute.execute(req, fakeRes());
    expect(result).toBeTruthy();
    expect(result!.status).toBe("failed");
    expect(result!.message).toMatch(/quantity/i);
  });
});

describe("post-holding-snapshot — per-user cap on the shared Polygon gate", () => {
  test("sheds once the caller's share is spent, before the lookup leaves the process", async () => {
    // A user id no other suite uses: the limiter's bucket is process-global.
    const userId = "u-holding-cap";
    accountRow = {
      ...Object.fromEntries(ACCOUNT_NULLABLE.map((k) => [k, null])),
      account_id: "a-1",
      user_id: userId,
      item_id: "item-1",
      institution_id: "ins-1",
      type: "investment",
    };

    for (let i = 0; i < 10; i++) {
      const result = await postHoldingSnapshotRoute.execute(
        makeReq({ account_id: "a-1", ticker_symbol: `NOPE${i}`, quantity: 1 }, userId),
        fakeRes(),
      );
      expect(result!.status).toBe("failed");
      expect(result!.message).toMatch(/could not be validated/i);
    }

    const shed = await postHoldingSnapshotRoute.execute(
      makeReq({ account_id: "a-1", ticker_symbol: "NOPE10", quantity: 1 }, userId),
      fakeRes(),
    );

    expect(shed!.status).toBe("failed");
    expect(shed!.message).toMatch(/too many/i);
    // The shed request spends no slot on the shared gate.
    expect(mockFetch).toHaveBeenCalledTimes(10);
  });
});

describe("post-holding-snapshot \u2014 upstream failures do not blame the symbol", () => {
  test("a plan rejection reports the plan, not an unverifiable ticker", async () => {
    const userId = "u-holding-plan-limit";
    accountRow = {
      ...Object.fromEntries(ACCOUNT_NULLABLE.map((k) => [k, null])),
      account_id: "a-1",
      user_id: userId,
      item_id: "item-1",
      institution_id: "ins-1",
      type: "investment",
    };
    mockFetch.mockImplementation(
      async () =>
        ({
          ok: false,
          status: 403,
          json: async () => ({ status: "NOT_AUTHORIZED", message: "not entitled" }),
        }) as unknown as Response,
    );

    const result = await postHoldingSnapshotRoute.execute(
      makeReq({ account_id: "a-1", ticker_symbol: "PLANX", quantity: 1 }, userId),
      fakeRes(),
    );

    expect(result!.status).toBe("failed");
    expect(result!.message).not.toMatch(/check the symbol/i);
    expect(result!.message).toMatch(/not entitled/i);
  });
});
