import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";

const { driver, mockUnsafe, resetSqlMocks } = createFakeSql();

mock.module("../../lib/postgres/sql-driver", () => driver);

const { deleteSnapshotRoute } = await import("./delete-snapshot");

afterAll(restoreLeaves);

beforeEach(() => {
  resetSqlMocks();
});

function makeReq(
  query: Record<string, unknown> = {},
  opts: { authenticated?: boolean; userId?: string } = {},
): Parameters<typeof deleteSnapshotRoute.execute>[0] {
  const authenticated = opts.authenticated ?? true;
  const userId = opts.userId ?? "u-1";
  return {
    method: "DELETE",
    path: "/snapshot",
    url: "http://x/api/snapshot",
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
  } as unknown as Parameters<typeof deleteSnapshotRoute.execute>[0];
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
  }) as unknown as Parameters<typeof deleteSnapshotRoute.execute>[1];

const findUpdateCall = (matcher: RegExp): { sql: string; values: unknown[] } | null => {
  for (const call of mockUnsafe.mock.calls) {
    const sql = call[0] as string;
    if (matcher.test(sql)) return { sql, values: call[1] as unknown[] };
  }
  return null;
};

describe("DELETE /api/snapshot", () => {
  test("rejects unauthenticated requests", async () => {
    const result = await deleteSnapshotRoute.execute(
      makeReq({ id: "snap-1" }, { authenticated: false }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/i);
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("rejects requests missing the id query parameter", async () => {
    const result = await deleteSnapshotRoute.execute(makeReq({}), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/id/i);
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("answers failed when the id matches no row for the caller", async () => {
    // The soft-delete's UPDATE matches zero rows: a missing id, or another
    // user's row — the WHERE carries the snapshot id and the caller's id.
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await deleteSnapshotRoute.execute(makeReq({ id: "snap-1" }), fakeRes());

    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not found/i);
    const upd = findUpdateCall(/UPDATE\s+snapshots/i);
    expect(upd).not.toBeNull();
    expect(upd!.values).toContain("snap-1");
    expect(upd!.values).toContain("u-1");
  });

  test("deletes a snapshot the user owns and reports success", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [{ snapshot_id: "snap-1" }], rowCount: 1 });

    const result = await deleteSnapshotRoute.execute(makeReq({ id: "snap-1" }), fakeRes());

    expect(result?.status).toBe("success");
    const upd = findUpdateCall(/UPDATE\s+snapshots/i);
    expect(upd).not.toBeNull();
    expect(upd!.values).toContain("snap-1");
    expect(upd!.values).toContain("u-1");
  });

  test("the delete stays retry-safe: its UPDATE filters on no is_deleted value", async () => {
    // `buildSoftDelete` matches an already-soft-deleted row again, so a
    // re-delete still answers success — the property the SnapshotsPage
    // date-edit guard rests on. If the UPDATE ever gains an
    // `is_deleted = FALSE` predicate, a re-delete would start answering
    // failed and the guard would misfire.
    mockUnsafe.mockResolvedValueOnce({ rows: [{ snapshot_id: "snap-1" }], rowCount: 1 });

    const result = await deleteSnapshotRoute.execute(makeReq({ id: "snap-1" }), fakeRes());

    expect(result?.status).toBe("success");
    const upd = findUpdateCall(/UPDATE\s+snapshots/i);
    expect(upd).not.toBeNull();
    // The SET clause sets is_deleted = TRUE; the WHERE clause must not
    // filter on it — that is what makes a re-delete match again.
    const where = upd!.sql.split(/WHERE/i)[1] ?? "";
    expect(where).not.toMatch(/is_deleted/i);
  });
});
