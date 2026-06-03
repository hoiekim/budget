//
// Originally lived in `holding-snapshot-sibling-routes.test.ts` together
// `get-holding-snapshots.test.bundle.ts`.
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

const { deleteHoldingSnapshotRoute } = await import("./delete-holding-snapshot");

afterAll(restoreLeaves);

beforeEach(() => {
  mockQuery.mockReset();
});

function makeReq(
  query: Record<string, unknown> = {},
  opts: { authenticated?: boolean; userId?: string } = {},
): Parameters<typeof deleteHoldingSnapshotRoute.execute>[0] {
  const authenticated = opts.authenticated ?? true;
  const userId = opts.userId ?? "u-1";
  return {
    method: "DELETE",
    path: "/snapshots/holding",
    url: "http://x/api/snapshots/holding",
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
  } as unknown as Parameters<typeof deleteHoldingSnapshotRoute.execute>[0];
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
  }) as unknown as Parameters<typeof deleteHoldingSnapshotRoute.execute>[1];

/**
 * A canned holding-snapshot row matching the projection the route's
 * `getHoldingSnapshots` does on the snapshots SELECT. Only the columns
 * the ownership-check actually consumes need to be present.
 */
const snapshotRow = (overrides: Record<string, unknown> = {}) => ({
  snapshot_id: "snap-1",
  snapshot_date: "2026-05-14",
  holding_account_id: "acc-1",
  holding_security_id: "sec-1",
  institution_price: "12.50",
  institution_value: "125.00",
  cost_basis: "100.00",
  quantity: "10",
  ...overrides,
});

const findUpdateCall = (matcher: RegExp): { sql: string; values: unknown[] } | null => {
  for (const call of mockQuery.mock.calls) {
    const sql = call[0] as string;
    if (matcher.test(sql)) return { sql, values: call[1] as unknown[] };
  }
  return null;
};

describe("DELETE /api/snapshots/holding", () => {
  test("rejects unauthenticated requests", async () => {
    const result = await deleteHoldingSnapshotRoute.execute(
      makeReq({ id: "snap-1" }, { authenticated: false }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("rejects requests missing the id query parameter", async () => {
    const result = await deleteHoldingSnapshotRoute.execute(makeReq({}), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/id/i);
    // No SELECT, no UPDATE should fire when the param is invalid.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("refuses to delete a snapshot owned by another user", async () => {
    // getHoldingSnapshots SELECT returns user u-1's snap-1 only — snap-other
    // is not among them, so ownership check fails before softDelete.
    mockQuery.mockResolvedValueOnce({ rows: [snapshotRow()], rowCount: 1 });

    const result = await deleteHoldingSnapshotRoute.execute(
      makeReq({ id: "snap-other" }),
      fakeRes(),
    );

    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not found or access denied/i);
    // No UPDATE issued (softDelete never reached).
    expect(findUpdateCall(/UPDATE\s+snapshots/i)).toBeNull();
  });

  test("deletes a snapshot the user owns and reports success", async () => {
    // 1: ownership SELECT returns the snapshot
    mockQuery.mockResolvedValueOnce({ rows: [snapshotRow()], rowCount: 1 });
    // 2: softDelete's UPDATE
    mockQuery.mockResolvedValueOnce({ rows: [{ snapshot_id: "snap-1" }], rowCount: 1 });

    const result = await deleteHoldingSnapshotRoute.execute(makeReq({ id: "snap-1" }), fakeRes());

    expect(result?.status).toBe("success");
    const upd = findUpdateCall(/UPDATE\s+snapshots/i);
    expect(upd).not.toBeNull();
    // The softDelete's UPDATE pins both the snapshot_id and the caller's
    // user_id into the WHERE clause.
    expect(upd!.values).toContain("snap-1");
    expect(upd!.values).toContain("u-1");
  });

  test("surfaces softDelete failure as a 500-style error response", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [snapshotRow()], rowCount: 1 });
    mockQuery.mockRejectedValueOnce(new Error("connection lost"));

    const result = await deleteHoldingSnapshotRoute.execute(
      makeReq({ id: "snap-1" }),
      fakeRes(),
    );
    expect(result?.status).toBe("error");
  });
});
