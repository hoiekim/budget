/**
 * Tests for the sibling routes around POST /api/snapshots/holding:
 *   - DELETE /api/snapshots/holding
 *   - GET    /api/snapshots/holding
 *
 * The POST route itself (`post-holding-snapshot.ts`, ~238 LOC) is intentionally
 * out of scope here — issue #359 splits cleanly into "exercise sibling routes"
 * (this file) and "exercise the create/update modes" (follow-up). Keeping the
 * two PRs separate keeps each diff reviewable.
 *
 * Mocking strategy mirrors `post-suggest-category.test.ts`: monkey-patch
 * shared-object methods (`pool.query`, `snapshotsTable.softDelete`,
 * `securitiesTable.queryOne`) on the real imports and restore in `afterAll`.
 * `mock.module("server", ...)` is process-wide in Bun and leaks into sibling
 * test files, so it is deliberately not used.
 */

import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";

import { pool } from "server";
import { snapshotsTable, securitiesTable } from "server/lib/postgres/repositories";
import { deleteHoldingSnapshotRoute } from "./delete-holding-snapshot";
import { getHoldingSnapshotsRoute } from "./get-holding-snapshots";

const originalPoolQuery = pool.query.bind(pool);
const originalSoftDelete = snapshotsTable.softDelete.bind(snapshotsTable);
const originalSecuritiesQueryOne = securitiesTable.queryOne.bind(securitiesTable);

const mockPoolQuery = mock(
  (_sql: string, _values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }> =>
    Promise.resolve({ rows: [], rowCount: 0 }),
);
const mockSoftDelete = mock(async (_id: unknown, _userId?: unknown): Promise<boolean> => true);
const mockSecuritiesQueryOne = mock(
  async (_filters: unknown): Promise<{ toJSON: () => Record<string, unknown> } | null> => null,
);

(pool as unknown as { query: typeof mockPoolQuery }).query = mockPoolQuery;
(snapshotsTable as unknown as { softDelete: typeof mockSoftDelete }).softDelete = mockSoftDelete;
(securitiesTable as unknown as { queryOne: typeof mockSecuritiesQueryOne }).queryOne =
  mockSecuritiesQueryOne;

afterAll(() => {
  (pool as unknown as { query: typeof originalPoolQuery }).query = originalPoolQuery;
  (snapshotsTable as unknown as { softDelete: typeof originalSoftDelete }).softDelete =
    originalSoftDelete;
  (securitiesTable as unknown as { queryOne: typeof originalSecuritiesQueryOne }).queryOne =
    originalSecuritiesQueryOne;
});

beforeEach(() => {
  mockPoolQuery.mockReset();
  mockSoftDelete.mockReset();
  mockSecuritiesQueryOne.mockReset();
});

type RouteUnderTest = typeof deleteHoldingSnapshotRoute | typeof getHoldingSnapshotsRoute;

function makeReq(
  query: Record<string, unknown> = {},
  opts: { authenticated?: boolean; userId?: string } = {},
): Parameters<RouteUnderTest["execute"]>[0] {
  const authenticated = opts.authenticated ?? true;
  const userId = opts.userId ?? "u-1";
  return {
    method: "GET",
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
  } as unknown as Parameters<RouteUnderTest["execute"]>[0];
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
  }) as unknown as Parameters<RouteUnderTest["execute"]>[1];

// A canned getHoldingSnapshots row — pool.query → these column names map to
// the route's flat HoldingSnapshot shape after the .rows.map() projection.
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

describe("DELETE /api/snapshots/holding", () => {
  test("rejects unauthenticated requests", async () => {
    const result = await deleteHoldingSnapshotRoute.execute(
      makeReq({ id: "snap-1" }, { authenticated: false }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/i);
    expect(mockPoolQuery).not.toHaveBeenCalled();
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  test("rejects requests missing the id query parameter", async () => {
    const result = await deleteHoldingSnapshotRoute.execute(makeReq({}), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/id/i);
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  test("refuses to delete a snapshot owned by another user", async () => {
    // getHoldingSnapshots returns user u-1's snapshots — snap-other is not
    // among them, so ownership check fails before deleteSnapshotById is reached.
    mockPoolQuery.mockResolvedValueOnce({ rows: [snapshotRow()], rowCount: 1 });

    const result = await deleteHoldingSnapshotRoute.execute(
      makeReq({ id: "snap-other" }),
      fakeRes(),
    );

    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not found or access denied/i);
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  test("deletes a snapshot the user owns and reports success", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [snapshotRow()], rowCount: 1 });
    mockSoftDelete.mockResolvedValueOnce(true);

    const result = await deleteHoldingSnapshotRoute.execute(makeReq({ id: "snap-1" }), fakeRes());

    expect(result?.status).toBe("success");
    expect(mockSoftDelete).toHaveBeenCalledTimes(1);
    expect(mockSoftDelete.mock.calls[0]?.[0]).toBe("snap-1");
    expect(mockSoftDelete.mock.calls[0]?.[1]).toBe("u-1");
  });

  test("surfaces softDelete failure as a 500-style error response", async () => {
    // Route.execute catches any throw from the handler, logs it, and returns
    // `{ status: "error", message: "Internal server error" }`. Verify the
    // delete failure path produces that envelope rather than a silent success.
    mockPoolQuery.mockResolvedValueOnce({ rows: [snapshotRow()], rowCount: 1 });
    mockSoftDelete.mockRejectedValueOnce(new Error("connection lost"));

    const result = await deleteHoldingSnapshotRoute.execute(
      makeReq({ id: "snap-1" }),
      fakeRes(),
    );
    expect(result?.status).toBe("error");
  });
});

describe("GET /api/snapshots/holding", () => {
  test("rejects unauthenticated requests", async () => {
    const result = await getHoldingSnapshotsRoute.execute(
      makeReq({}, { authenticated: false }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/i);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  test("returns an empty list when the user has no snapshots", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await getHoldingSnapshotsRoute.execute(makeReq({}), fakeRes());

    expect(result?.status).toBe("success");
    expect(result?.body).toEqual({ snapshots: [] });
    // No snapshots → searchSecuritiesById short-circuits on empty input and
    // does not call securitiesTable.queryOne.
    expect(mockSecuritiesQueryOne).not.toHaveBeenCalled();
  });

  test("hydrates each snapshot with ticker_symbol + security_name from securities lookup", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [snapshotRow({ snapshot_id: "snap-1", holding_security_id: "sec-1" })],
      rowCount: 1,
    });
    mockSecuritiesQueryOne.mockResolvedValueOnce({
      toJSON: () => ({
        security_id: "sec-1",
        ticker_symbol: "AAA",
        name: "Anonymized Asset",
      }),
    });

    const result = await getHoldingSnapshotsRoute.execute(makeReq({}), fakeRes());

    expect(result?.status).toBe("success");
    expect(result?.body?.snapshots).toHaveLength(1);
    const s = result?.body?.snapshots[0];
    expect(s?.snapshot_id).toBe("snap-1");
    expect(s?.ticker_symbol).toBe("AAA");
    expect(s?.security_name).toBe("Anonymized Asset");
  });

  test("returns null ticker/name when the security cannot be found", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [snapshotRow({ snapshot_id: "snap-2", holding_security_id: "sec-missing" })],
      rowCount: 1,
    });
    mockSecuritiesQueryOne.mockResolvedValueOnce(null);

    const result = await getHoldingSnapshotsRoute.execute(makeReq({}), fakeRes());

    expect(result?.status).toBe("success");
    const s = result?.body?.snapshots[0];
    expect(s?.ticker_symbol).toBeNull();
    expect(s?.security_name).toBeNull();
  });

  test("dedupes the security lookup across snapshots that share a security_id", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        snapshotRow({ snapshot_id: "snap-a", holding_security_id: "sec-shared" }),
        snapshotRow({ snapshot_id: "snap-b", holding_security_id: "sec-shared" }),
        snapshotRow({ snapshot_id: "snap-c", holding_security_id: "sec-shared" }),
      ],
      rowCount: 3,
    });
    mockSecuritiesQueryOne.mockResolvedValueOnce({
      toJSON: () => ({
        security_id: "sec-shared",
        ticker_symbol: "BBB",
        name: "Shared Security",
      }),
    });

    const result = await getHoldingSnapshotsRoute.execute(makeReq({}), fakeRes());

    expect(result?.status).toBe("success");
    expect(result?.body?.snapshots).toHaveLength(3);
    // 3 snapshots referencing the same security_id → 1 security lookup, not 3.
    expect(mockSecuritiesQueryOne).toHaveBeenCalledTimes(1);
    for (const s of result?.body?.snapshots ?? []) {
      expect(s.ticker_symbol).toBe("BBB");
    }
  });
});
