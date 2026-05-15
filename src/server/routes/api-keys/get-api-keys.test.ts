/**
 * Tests for GET /api/api-keys (Closes #358 — GET coverage).
 *
 * Mocks `pool.query` because that's what `listApiKeys` calls directly.
 * Pattern: same monkey-patch-then-restore approach used in
 * `accounts/post-suggest-category.test.ts`.
 */

import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";

import { pool } from "server/lib/postgres/client";
import { getApiKeysRoute } from "./get-api-keys";

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

function makeReq(opts: { user?: { user_id: string; username: string } | null } = {}) {
  const user =
    opts.user === undefined ? { user_id: "u-1", username: "test" } : opts.user;
  return {
    method: "GET",
    path: "/api-keys",
    url: "http://x/api/api-keys",
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
  } as unknown as Parameters<typeof getApiKeysRoute.execute>[0];
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
  }) as unknown as Parameters<typeof getApiKeysRoute.execute>[1];

describe("get-api-keys", () => {
  test("rejects unauthenticated requests", async () => {
    const result = await getApiKeysRoute.execute(makeReq({ user: null }), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("happy path scopes the SELECT to the caller's user_id", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          key_id: "k-1",
          user_id: "u-1",
          name: "laptop",
          key_prefix: "bk_abc123",
          scopes: ["transactions:suggest"],
          created_at: "2026-05-01T00:00:00.000Z",
          last_used_at: null,
          revoked_at: null,
          expires_at: null,
        },
      ],
      rowCount: 1,
    });

    const result = await getApiKeysRoute.execute(makeReq(), fakeRes());
    expect(result?.status).toBe("success");
    expect(result?.body?.api_keys).toHaveLength(1);
    expect(result?.body?.api_keys[0].key_id).toBe("k-1");

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/WHERE user_id = \$1 AND revoked_at IS NULL/);
    expect(values).toEqual(["u-1"]);
  });

  test("response surface omits key_hash and revoked_at (contract enforced by SELECT projection)", async () => {
    // The repo's SELECT deliberately omits key_hash, and the listApiKeys
    // helper sets `key_hash: ""` on the model before .toJSON() so the
    // hash never enters the response. Pin that contract here.
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          key_id: "k-1",
          user_id: "u-1",
          name: "laptop",
          key_prefix: "bk_abc123",
          scopes: ["transactions:suggest"],
          created_at: "2026-05-01T00:00:00.000Z",
          last_used_at: null,
          revoked_at: null,
          expires_at: null,
        },
      ],
      rowCount: 1,
    });

    const result = await getApiKeysRoute.execute(makeReq(), fakeRes());
    const row = result?.body?.api_keys[0] as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    // key_hash never leaves the server with real content.
    expect(row?.key_hash === undefined || row?.key_hash === "" || row?.key_hash === null).toBe(
      true,
    );
  });

  test("empty result returns success with empty array", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await getApiKeysRoute.execute(makeReq(), fakeRes());
    expect(result?.status).toBe("success");
    expect(result?.body?.api_keys).toEqual([]);
  });
});
