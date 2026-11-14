import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";

const { driver, mockUnsafe, resetSqlMocks } = createFakeSql();

mock.module("../../lib/postgres/sql-driver", () => driver);

const { deleteApiKeyRoute } = await import("./delete\-api\-key");

afterAll(restoreLeaves);

beforeEach(() => {
  resetSqlMocks();
});

function makeReq(
  query: Record<string, unknown>,
  opts: { user?: { user_id: string; username: string } | null } = {},
) {
  const user = opts.user === undefined ? { user_id: "u-1", username: "test" } : opts.user;
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
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("rejects missing key_id query param", async () => {
    const result = await deleteApiKeyRoute.execute(makeReq({}), fakeRes());
    expect(result?.status).toBe("failed");
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("returns failed when no rows are updated (not found / wrong owner / already revoked)", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await deleteApiKeyRoute.execute(makeReq({ key_id: "k-missing" }), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not found or already revoked/);
  });

  test("happy path returns { revoked: true } and pins user_id into the WHERE clause", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [{ key_id: "k-1" }], rowCount: 1 });
    const result = await deleteApiKeyRoute.execute(makeReq({ key_id: "k-1" }), fakeRes());
    expect(result?.status).toBe("success");
    expect(result?.body).toEqual({ revoked: true });
    expect(mockUnsafe).toHaveBeenCalledTimes(1);
    const [sql, values] = mockUnsafe.mock.calls[0];
    expect(sql).toContain("UPDATE api_keys");
    expect(sql).toContain("revoked_at");
    expect(sql).toContain("IS NULL");
    expect(values).toContain("k-1");
    expect(values).toContain("u-1");
  });

  test("cross-user revoke: the route always uses the *session* user_id, never a client-supplied value", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await deleteApiKeyRoute.execute(
      makeReq({ key_id: "k-belongs-to-B" }, { user: { user_id: "u-A", username: "a" } }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    const [, values] = mockUnsafe.mock.calls[0];
    expect(values).toContain("k-belongs-to-B");
    expect(values).toContain("u-A");
  });
});
