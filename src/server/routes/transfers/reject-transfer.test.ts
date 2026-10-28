import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";

const { driver, mockUnsafe, resetSqlMocks } = createFakeSql();

mock.module("../../lib/postgres/sql-driver", () => driver);

const { rejectTransferRoute } = await import("./reject\-transfer");

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
  } as unknown as Parameters<typeof rejectTransferRoute.execute>[0];
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
  }) as unknown as Parameters<typeof rejectTransferRoute.execute>[1];

describe("reject-transfer", () => {
  test("rejects unauthenticated requests", async () => {
    const result = await rejectTransferRoute.execute(
      makeReq({ id: "p-1" }, { user: null }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/);
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("rejects missing id query param", async () => {
    const result = await rejectTransferRoute.execute(makeReq({}), fakeRes());
    expect(result?.status).toBe("failed");
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("rejects empty id query param", async () => {
    const result = await rejectTransferRoute.execute(makeReq({ id: "   " }), fakeRes());
    expect(result?.status).toBe("failed");
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("rejects array id query param (?id=a&id=b)", async () => {
    const result = await rejectTransferRoute.execute(makeReq({ id: ["a", "b"] }), fakeRes());
    expect(result?.status).toBe("failed");
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("happy path returns success and pins user_id into the WHERE clause", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const result = await rejectTransferRoute.execute(
      makeReq({ id: "a8e9c6d4-1234-4abc-8def-0123456789ab" }),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    expect(mockUnsafe).toHaveBeenCalledTimes(1);
    const [sql, values] = mockUnsafe.mock.calls[0];
    expect(sql).toMatch(/UPDATE transaction_pairs/i);
    expect(sql).toMatch(/user_id/);
    expect(values).toContain("a8e9c6d4-1234-4abc-8def-0123456789ab");
    expect(values).toContain("u-1");
  });

  test("rejects a non-UUID id at the boundary — never reaches the DB", async () => {
    const result = await rejectTransferRoute.execute(
      makeReq({ id: "not-a-uuid" }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/id must be a uuid/);
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("cross-user delete: the route forwards the session user_id, never a client value", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await rejectTransferRoute.execute(
      makeReq(
        { id: "b7d8a5c3-2345-4bcd-9efa-1234567890cd" },
        { user: { user_id: "u-A", username: "a" } },
      ),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    const [, values] = mockUnsafe.mock.calls[0];
    expect(values).toContain("b7d8a5c3-2345-4bcd-9efa-1234567890cd");
    expect(values).toContain("u-A");
    expect(values).not.toContain("u-B");
  });
});
