// Per-test-bundle isolation — see scripts/test-bundled/.
//
// This file holds the GET-route half of what used to live in
// holding-snapshot-sibling-routes.test.ts. Each bundled test file maps
// 1:1 to a `@bundles` source via the per-test-bundle pattern; the two
// routes (delete + get) live in two source files, so they migrate to
// two bundled tests.
// @bundles src/server/routes/accounts/get-holding-snapshots.ts
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { bundleOf } from "test-bundled";

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

const { getHoldingSnapshotsRoute } = await bundleOf<typeof import("./get-holding-snapshots")>(import.meta.url);

beforeEach(() => {
  mockQuery.mockReset();
});

function makeReq(
  query: Record<string, unknown> = {},
  opts: { authenticated?: boolean; userId?: string } = {},
): Parameters<typeof getHoldingSnapshotsRoute.execute>[0] {
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
  } as unknown as Parameters<typeof getHoldingSnapshotsRoute.execute>[0];
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
  }) as unknown as Parameters<typeof getHoldingSnapshotsRoute.execute>[1];

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

/**
 * Raw `securities` row matching SecurityModel's schema. SecurityModel's
 * `typeChecker` requires every column to be present (null is fine,
 * undefined is not), so this returns the full row shape.
 */
const securityRow = (overrides: Record<string, unknown> = {}) => ({
  security_id: "sec-1",
  name: "Anonymized Asset",
  ticker_symbol: "AAA",
  type: null,
  close_price: null,
  close_price_as_of: null,
  iso_currency_code: null,
  isin: null,
  cusip: null,
  raw: null,
  updated: null,
  ...overrides,
});

describe("GET /api/snapshots/holding", () => {
  test("rejects unauthenticated requests", async () => {
    const result = await getHoldingSnapshotsRoute.execute(
      makeReq({}, { authenticated: false }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("returns an empty list when the user has no snapshots", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await getHoldingSnapshotsRoute.execute(makeReq({}), fakeRes());

    expect(result?.status).toBe("success");
    expect(result?.body).toEqual({ snapshots: [] });
    // No snapshots → searchSecuritiesById short-circuits on empty input
    // and never issues the second SELECT against `securities`.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test("hydrates each snapshot with ticker_symbol + security_name from securities lookup", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [snapshotRow({ snapshot_id: "snap-1", holding_security_id: "sec-1" })],
      rowCount: 1,
    });
    mockQuery.mockResolvedValueOnce({
      rows: [securityRow()],
      rowCount: 1,
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
    mockQuery.mockResolvedValueOnce({
      rows: [snapshotRow({ snapshot_id: "snap-2", holding_security_id: "sec-missing" })],
      rowCount: 1,
    });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await getHoldingSnapshotsRoute.execute(makeReq({}), fakeRes());

    expect(result?.status).toBe("success");
    const s = result?.body?.snapshots[0];
    expect(s?.ticker_symbol).toBeNull();
    expect(s?.security_name).toBeNull();
  });

  test("dedupes the security lookup across snapshots that share a security_id", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        snapshotRow({ snapshot_id: "snap-a", holding_security_id: "sec-shared" }),
        snapshotRow({ snapshot_id: "snap-b", holding_security_id: "sec-shared" }),
        snapshotRow({ snapshot_id: "snap-c", holding_security_id: "sec-shared" }),
      ],
      rowCount: 3,
    });
    mockQuery.mockResolvedValueOnce({
      rows: [securityRow({ security_id: "sec-shared", ticker_symbol: "BBB", name: "Shared Security" })],
      rowCount: 1,
    });

    const result = await getHoldingSnapshotsRoute.execute(makeReq({}), fakeRes());

    expect(result?.status).toBe("success");
    expect(result?.body?.snapshots).toHaveLength(3);
    // 3 snapshots referencing the same security_id → 1 security lookup
    // total (the snapshots SELECT + ONE securities SELECT).
    expect(mockQuery).toHaveBeenCalledTimes(2);
    for (const s of result?.body?.snapshots ?? []) {
      expect(s.ticker_symbol).toBe("BBB");
    }
  });
});
