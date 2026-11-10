import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";

const { driver, mockUnsafe, resetSqlMocks } = createFakeSql();

mock.module("../../lib/postgres/sql-driver", () => driver);

const { deleteSplitTransactionRoute } = await import("./delete-split-transaction");

afterAll(restoreLeaves);

beforeEach(() => {
  resetSqlMocks();
});

const SPLIT_ID = "11111111-1111-4111-8111-111111111111";

function makeReq(
  query: Record<string, unknown> = {},
  opts: { authenticated?: boolean; userId?: string } = {},
): Parameters<typeof deleteSplitTransactionRoute.execute>[0] {
  const authenticated = opts.authenticated ?? true;
  const userId = opts.userId ?? "u-1";
  return {
    method: "DELETE",
    path: "/split-transaction",
    url: "http://x/api/split-transaction",
    headers: {},
    query,
    body: {},
    session: {
      id: "s-1",
      user: authenticated ? { user_id: userId, username: "alice" } : undefined,
      regenerate() {},
      destroy() {},
    },
    ip: "127.0.0.1",
  } as unknown as Parameters<typeof deleteSplitTransactionRoute.execute>[0];
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
  }) as unknown as Parameters<typeof deleteSplitTransactionRoute.execute>[1];

const findUpdateCall = (matcher: RegExp): { sql: string; values: unknown[] } | null => {
  for (const call of mockUnsafe.mock.calls) {
    const sql = call[0] as string;
    if (matcher.test(sql)) return { sql, values: call[1] as unknown[] };
  }
  return null;
};

describe("DELETE /api/split-transaction", () => {
  test("rejects unauthenticated requests", async () => {
    const result = await deleteSplitTransactionRoute.execute(
      makeReq({ id: SPLIT_ID }, { authenticated: false }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/i);
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("rejects requests missing the id query parameter", async () => {
    const result = await deleteSplitTransactionRoute.execute(makeReq({}), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/id/i);
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("rejects a malformed id before any SQL fires", async () => {
    const result = await deleteSplitTransactionRoute.execute(
      makeReq({ id: "not-a-uuid" }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("answers failed when the id matches no row for the caller", async () => {
    // The bulk soft-delete matches zero rows: a missing id, or another
    // user's row — the WHERE carries the split id and the caller's id.
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await deleteSplitTransactionRoute.execute(
      makeReq({ id: SPLIT_ID }),
      fakeRes(),
    );

    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not found/i);
    const upd = findUpdateCall(/UPDATE\s+split_transactions/i);
    expect(upd).not.toBeNull();
    expect(upd!.values).toContain(SPLIT_ID);
    expect(upd!.values).toContain("u-1");
  });

  test("deletes a split the user owns and reports success", async () => {
    mockUnsafe.mockResolvedValueOnce({
      rows: [{ split_transaction_id: SPLIT_ID }],
      rowCount: 1,
    });

    const result = await deleteSplitTransactionRoute.execute(
      makeReq({ id: SPLIT_ID }),
      fakeRes(),
    );

    expect(result?.status).toBe("success");
    const upd = findUpdateCall(/UPDATE\s+split_transactions/i);
    expect(upd).not.toBeNull();
    expect(upd!.values).toContain(SPLIT_ID);
    expect(upd!.values).toContain("u-1");
  });

  test("the delete stays retry-safe: its UPDATE filters on no is_deleted value", async () => {
    // `bulkSoftDelete` matches an already-soft-deleted row again, so a
    // re-delete still answers success — the property the split-amount
    // zeroing guard in SplitTransactionRow rests on.
    mockUnsafe.mockResolvedValueOnce({
      rows: [{ split_transaction_id: SPLIT_ID }],
      rowCount: 1,
    });

    const result = await deleteSplitTransactionRoute.execute(
      makeReq({ id: SPLIT_ID }),
      fakeRes(),
    );

    expect(result?.status).toBe("success");
    const upd = findUpdateCall(/UPDATE\s+split_transactions/i);
    expect(upd).not.toBeNull();
    // The SET clause sets is_deleted = TRUE; the WHERE clause must not
    // filter on it — that is what makes a re-delete match again.
    const where = upd!.sql.split(/WHERE/i)[1] ?? "";
    expect(where).not.toMatch(/is_deleted/i);
  });
});
