/**
 * Tests for DELETE /transfers (Closes #378 — DELETE coverage).
 *
 * `removeTransferPair` calls `transactionPairsTable.softDelete`, which
 * underneath issues a single `pool.query`. Mock at the pool layer to
 * pin the route contract: the session user_id is forwarded into the
 * WHERE clause as `user_id` — never a client-supplied value.
 */

import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";

import { pool } from "server/lib/postgres/client";
import { deleteTransferRoute } from "./delete-transfer";

const originalQuery = pool.query.bind(pool);

const mockQuery = mock(
  (_sql: string, _values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }> =>
    Promise.resolve({ rows: [], rowCount: 0 }),
);

(pool as unknown as { query: typeof mockQuery }).query = mockQuery;

afterAll(() => {
  (pool as unknown as { query: typeof originalQuery }).query = originalQuery;
});

beforeEach(() => {
  mockQuery.mockReset();
});

function makeReq(
  query: Record<string, unknown>,
  opts: { user?: { user_id: string; username: string } | null } = {},
) {
  const user =
    opts.user === undefined ? { user_id: "u-1", username: "test" } : opts.user;
  return {
    method: "DELETE",
    path: "/transfers",
    url: "http://x/api/transfers",
    headers: {},
    query,
    body: undefined,
    session: {
      id: "s-1",
      user: user ?? undefined,
      regenerate() {},
      destroy() {},
    },
    ip: "127.0.0.1",
  } as unknown as Parameters<typeof deleteTransferRoute.execute>[0];
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
  }) as unknown as Parameters<typeof deleteTransferRoute.execute>[1];

describe("delete-transfer", () => {
  test("rejects unauthenticated requests", async () => {
    const result = await deleteTransferRoute.execute(
      makeReq({ id: "p-1" }, { user: null }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("rejects missing id query param", async () => {
    const result = await deleteTransferRoute.execute(makeReq({}), fakeRes());
    expect(result?.status).toBe("failed");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("rejects empty id query param", async () => {
    const result = await deleteTransferRoute.execute(makeReq({ id: "   " }), fakeRes());
    expect(result?.status).toBe("failed");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("rejects array id query param (?id=a&id=b)", async () => {
    const result = await deleteTransferRoute.execute(
      makeReq({ id: ["a", "b"] }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("happy path returns success and pins user_id into the WHERE clause", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const result = await deleteTransferRoute.execute(makeReq({ id: "p-1" }), fakeRes());
    expect(result?.status).toBe("success");
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, values] = mockQuery.mock.calls[0];
    // softDelete issues an UPDATE with both the primary key and user_id in the WHERE.
    expect(sql).toMatch(/UPDATE transaction_pairs/i);
    expect(sql).toMatch(/user_id/);
    expect(values).toContain("p-1");
    expect(values).toContain("u-1");
  });

  test("cross-user delete: the route forwards the session user_id, never a client value", async () => {
    // User A is logged in and asks to delete a pair_id that belongs to user B.
    // The WHERE clause includes user_id = session.user.user_id, so the
    // soft-delete won't affect user B's row. We pin that the value supplied
    // to the query is the *session* user_id (u-A), not anything from the request.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await deleteTransferRoute.execute(
      makeReq({ id: "p-belongs-to-B" }, { user: { user_id: "u-A", username: "a" } }),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    const [, values] = mockQuery.mock.calls[0];
    expect(values).toContain("p-belongs-to-B");
    expect(values).toContain("u-A");
    expect(values).not.toContain("u-B");
  });
});
