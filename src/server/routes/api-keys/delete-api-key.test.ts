/**
 * Tests for DELETE /api/api-keys (Closes #358 — DELETE coverage).
 *
 * Mocks `pool.query` because `revokeApiKey` issues a single UPDATE there.
 * The cross-user ownership check is enforced at the SQL level by the
 * `WHERE user_id = $2` clause; these tests pin the route contract and
 * verify the session user_id reaches the query unchanged (never a
 * client-supplied value).
 */

import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";

import { pool } from "server/lib/postgres/client";
import { deleteApiKeyRoute } from "./delete-api-key";

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
    path: "/api-keys",
    url: "http://x/api/api-keys",
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
  } as unknown as Parameters<typeof deleteApiKeyRoute.execute>[0];
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
  }) as unknown as Parameters<typeof deleteApiKeyRoute.execute>[1];

describe("delete-api-key", () => {
  test("rejects unauthenticated requests", async () => {
    const result = await deleteApiKeyRoute.execute(
      makeReq({ key_id: "k-1" }, { user: null }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("rejects missing key_id query param", async () => {
    const result = await deleteApiKeyRoute.execute(makeReq({}), fakeRes());
    expect(result?.status).toBe("failed");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("returns failed when no rows are updated (not found / wrong owner / already revoked)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await deleteApiKeyRoute.execute(
      makeReq({ key_id: "k-missing" }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not found or already revoked/);
  });

  test("happy path returns { revoked: true } and pins user_id into the WHERE clause", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ key_id: "k-1" }], rowCount: 1 });
    const result = await deleteApiKeyRoute.execute(makeReq({ key_id: "k-1" }), fakeRes());
    expect(result?.status).toBe("success");
    expect(result?.body).toEqual({ revoked: true });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/WHERE key_id = \$1 AND user_id = \$2 AND revoked_at IS NULL/);
    expect(values).toEqual(["k-1", "u-1"]);
  });

  test("cross-user revoke: the route always uses the *session* user_id, never a client-supplied value", async () => {
    // User A attempts to revoke a key that belongs to User B. The session
    // user (u-A) is the only value the route will accept for user_id, even
    // if a future request body somehow tried to override it.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await deleteApiKeyRoute.execute(
      makeReq({ key_id: "k-belongs-to-B" }, { user: { user_id: "u-A", username: "a" } }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    const [, values] = mockQuery.mock.calls[0];
    expect(values).toEqual(["k-belongs-to-B", "u-A"]);
  });
});
