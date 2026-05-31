// Per-test-bundle isolation — see scripts/test-bundled/.
// @bundles src/server/routes/transfers/delete-transfer.ts
import { describe, test, expect, mock, beforeEach } from "bun:test";

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

const { deleteTransferRoute } = await import("./delete-transfer");

beforeEach(() => {
  mockQuery.mockReset();
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
    const result = await deleteTransferRoute.execute(makeReq({ id: ["a", "b"] }), fakeRes());
    expect(result?.status).toBe("failed");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("happy path returns success and pins user_id into the WHERE clause", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const result = await deleteTransferRoute.execute(makeReq({ id: "p-1" }), fakeRes());
    expect(result?.status).toBe("success");
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE transaction_pairs/i);
    expect(sql).toMatch(/user_id/);
    expect(values).toContain("p-1");
    expect(values).toContain("u-1");
  });

  test("cross-user delete: the route forwards the session user_id, never a client value", async () => {
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
