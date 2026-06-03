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

const { getTransfersRoute } = await import("./get\-transfers");

afterAll(restoreLeaves);

beforeEach(() => {
  mockQuery.mockReset();
});

function makeReq(opts: { user?: { user_id: string; username: string } | null } = {}) {
  const user = opts.user === undefined ? { user_id: "u-1", username: "test" } : opts.user;
  return {
    method: "GET",
    path: "/transfers",
    url: "http://x/api/transfers",
    headers: {},
    query: {},
    body: undefined,
    session: {
      id: "s-1",
      user: user ?? undefined,
      regenerate() {},
      destroy() {},
    },
    ip: "127.0.0.1",
  } as unknown as Parameters<typeof getTransfersRoute.execute>[0];
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
  }) as unknown as Parameters<typeof getTransfersRoute.execute>[1];

describe("get-transfers", () => {
  test("rejects unauthenticated requests", async () => {
    const result = await getTransfersRoute.execute(makeReq({ user: null }), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("empty pairs list returns success with empty array — no second query issued", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await getTransfersRoute.execute(makeReq(), fakeRes());
    expect(result?.status).toBe("success");
    expect(result?.body).toEqual([]);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test("happy path scopes the pairs SELECT to the caller's user_id", async () => {
    const pairRow = {
      pair_id: "p-1",
      user_id: "u-1",
      transaction_id_a: "t-a",
      transaction_id_b: "t-b",
      status: "confirmed",
      created_at: "2026-05-01T00:00:00Z",
      updated: "2026-05-01T00:00:00Z",
      is_deleted: false,
    };
    const txnRow = (id: string, amount: number) => ({
      transaction_id: id,
      user_id: "u-1",
      account_id: "acc-1",
      name: "Transfer",
      merchant_name: null,
      amount,
      iso_currency_code: "USD",
      date: "2026-05-01",
      pending: false,
      pending_transaction_id: null,
      payment_channel: "other",
      location_country: null,
      location_region: null,
      location_city: null,
      label_budget_id: null,
      label_category_id: null,
      label_memo: null,
      label_category_confidence: null,
      raw: null,
      updated: "2026-05-01T00:00:00Z",
      is_deleted: false,
    });
    mockQuery.mockResolvedValueOnce({ rows: [pairRow], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({
      rows: [txnRow("t-a", 100), txnRow("t-b", -100)],
      rowCount: 2,
    });

    const result = await getTransfersRoute.execute(makeReq(), fakeRes());
    expect(result?.status).toBe("success");
    expect(result?.body).toHaveLength(1);
    expect(result?.body?.[0].pair_id).toBe("p-1");
    expect(result?.body?.[0].status).toBe("confirmed");
    expect(result?.body?.[0].transactions).toHaveLength(2);

    expect(mockQuery).toHaveBeenCalledTimes(2);
    const [pairsSql, pairsValues] = mockQuery.mock.calls[0];
    expect(pairsSql).toMatch(/FROM transaction_pairs/);
    expect(pairsSql).toMatch(/WHERE user_id = \$1/);
    expect(pairsValues).toEqual(["u-1"]);

    const [txnsSql, txnsValues] = mockQuery.mock.calls[1];
    expect(txnsSql).toMatch(/WHERE user_id = \$1/);
    expect(txnsValues?.[0]).toBe("u-1");
  });

  test("cross-user isolation: another user's pairs are never returned", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await getTransfersRoute.execute(
      makeReq({ user: { user_id: "u-B", username: "b" } }),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    expect(result?.body).toEqual([]);
    const [, values] = mockQuery.mock.calls[0];
    expect(values).toEqual(["u-B"]);
  });
});
