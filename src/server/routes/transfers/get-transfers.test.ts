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

function makeReq(
  opts: {
    user?: { user_id: string; username: string } | null;
    query?: Record<string, unknown>;
  } = {},
) {
  const user = opts.user === undefined ? { user_id: "u-1", username: "test" } : opts.user;
  return {
    method: "GET",
    path: "/transfers",
    url: "http://x/api/transfers",
    headers: {},
    query: opts.query ?? {},
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
      source: "plaid",
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

  test("projects `updated` and `is_deleted: false` on active pairs (delta-delivery contract)", async () => {
    const pairRow = {
      pair_id: "p-1",
      user_id: "u-1",
      transaction_id_a: "t-a",
      transaction_id_b: "t-b",
      status: "confirmed",
      created_at: "2026-05-01T00:00:00Z",
      updated: "2026-05-02T09:00:00Z",
      is_deleted: false,
    };
    const txnRow = (id: string) => ({
      transaction_id: id,
      user_id: "u-1",
      account_id: "acc-1",
      name: "Transfer",
      merchant_name: null,
      amount: 0,
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
      source: "plaid",
    });
    mockQuery.mockResolvedValueOnce({ rows: [pairRow], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [txnRow("t-a"), txnRow("t-b")], rowCount: 2 });

    const result = await getTransfersRoute.execute(makeReq(), fakeRes());
    expect(result?.body?.[0].updated).toBe("2026-05-02T09:00:00Z");
    expect(result?.body?.[0].is_deleted).toBe(false);
  });

  test("default (no include-deleted) excludes soft-deleted pairs at the SQL layer", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await getTransfersRoute.execute(makeReq(), fakeRes());
    const [pairsSql] = mockQuery.mock.calls[0];
    expect(pairsSql).toMatch(/is_deleted IS NULL OR is_deleted = FALSE/);
  });

  test("include-deleted=true delivers soft-deleted pairs as tombstones — no txn query, includes deleted at SQL layer", async () => {
    const deletedPairRow = {
      pair_id: "p-dead",
      user_id: "u-1",
      transaction_id_a: "t-a",
      transaction_id_b: "t-b",
      status: "confirmed",
      created_at: "2026-05-01T00:00:00Z",
      updated: "2026-05-03T12:00:00Z",
      is_deleted: true,
    };
    mockQuery.mockResolvedValueOnce({ rows: [deletedPairRow], rowCount: 1 });

    const result = await getTransfersRoute.execute(
      makeReq({ query: { "include-deleted": "true" } }),
      fakeRes(),
    );

    expect(result?.status).toBe("success");
    // Tombstone shape: pair_id + is_deleted + updated, no transactions.
    expect(result?.body).toEqual([
      { pair_id: "p-dead", status: "confirmed", transactions: [], updated: "2026-05-03T12:00:00Z", is_deleted: true },
    ]);
    // A tombstone needs no transaction resolution — only the pairs SELECT runs.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    // Soft-delete exclusion is dropped so tombstones surface.
    const [pairsSql] = mockQuery.mock.calls[0];
    expect(pairsSql).not.toMatch(/is_deleted IS NULL OR is_deleted = FALSE/);
  });

  test("include-deleted=true delivers rejected (non-deleted) pairs as eviction signals — transfers' second FE-hidden axis", async () => {
    // A rejected pair is not soft-deleted, but it is FE-hidden. Under the
    // delta contract it must be delivered as an eviction signal so the
    // reducing FE removes a pair that flipped suggested/confirmed → rejected.
    const rejectedPairRow = {
      pair_id: "p-rej",
      user_id: "u-1",
      transaction_id_a: "t-a",
      transaction_id_b: "t-b",
      status: "rejected",
      created_at: "2026-05-01T00:00:00Z",
      updated: "2026-05-04T08:00:00Z",
      is_deleted: false,
    };
    mockQuery.mockResolvedValueOnce({ rows: [rejectedPairRow], rowCount: 1 });

    const result = await getTransfersRoute.execute(
      makeReq({ query: { "include-deleted": "true" } }),
      fakeRes(),
    );

    expect(result?.status).toBe("success");
    // Eviction signal carries status='rejected' + is_deleted:false, no txns.
    expect(result?.body).toEqual([
      { pair_id: "p-rej", status: "rejected", transactions: [], updated: "2026-05-04T08:00:00Z", is_deleted: false },
    ]);
    // No transaction resolution for eviction signals.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test("default (no include-deleted) omits rejected pairs entirely — not delivered as eviction signals", async () => {
    const rejectedPairRow = {
      pair_id: "p-rej",
      user_id: "u-1",
      transaction_id_a: "t-a",
      transaction_id_b: "t-b",
      status: "rejected",
      created_at: "2026-05-01T00:00:00Z",
      updated: "2026-05-04T08:00:00Z",
      is_deleted: false,
    };
    mockQuery.mockResolvedValueOnce({ rows: [rejectedPairRow], rowCount: 1 });

    const result = await getTransfersRoute.execute(makeReq(), fakeRes());
    // On the wholesale-replace default path, a rejected pair is simply absent
    // (absence = eviction); it must NOT surface as an eviction-signal row.
    expect(result?.body).toEqual([]);
    // No second (txn) query — nothing visible to resolve.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});
