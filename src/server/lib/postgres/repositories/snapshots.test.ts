/**
 * Tests for the searchSnapshots two-pass logic (#323):
 * user-scoped snapshots (account_balance / holding) + global security
 * snapshots (user_id NULL), with the second pass skipped when the caller
 * narrows the request to a specific account or non-security snapshot_type.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

const mockQuery = mock(
  (_sql: string, _values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }> =>
    Promise.resolve({ rows: [], rowCount: 0 }),
);

mock.module("../client", () => ({
  pool: { query: mockQuery },
}));

const mockSearchSecuritiesById = mock(async (_ids: string[]) => [] as unknown[]);
mock.module("./securities", () => ({
  searchSecuritiesById: mockSearchSecuritiesById,
}));

import { searchSnapshots } from "./snapshots";

const testUser = { user_id: "usr-1", username: "hoie" };

// SnapshotModel's typeChecker requires every column to be present (null is
// fine, undefined is not). These helpers return the full row shape.
function makeBaseRow(overrides: Record<string, unknown> = {}) {
  return {
    snapshot_id: "snap-0",
    user_id: null,
    snapshot_date: "2026-05-10",
    snapshot_type: "account_balance",
    account_id: null,
    balances_available: null,
    balances_current: null,
    balances_limit: null,
    balances_iso_currency_code: null,
    security_id: null,
    close_price: null,
    holding_account_id: null,
    holding_security_id: null,
    institution_price: null,
    institution_value: null,
    cost_basis: null,
    quantity: null,
    updated: null,
    is_deleted: false,
    ...overrides,
  };
}

function makeAccountRow(overrides: Record<string, unknown> = {}) {
  return makeBaseRow({
    snapshot_id: "snap-acct-1",
    user_id: "usr-1",
    snapshot_type: "account_balance",
    account_id: "acc-1",
    balances_current: 1000,
    balances_available: 900,
    balances_iso_currency_code: "USD",
    ...overrides,
  });
}

function makeSecurityRow(overrides: Record<string, unknown> = {}) {
  return makeBaseRow({
    snapshot_id: "snap-sec-1",
    snapshot_type: "security",
    security_id: "sec-aapl",
    close_price: 195.5,
    ...overrides,
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockSearchSecuritiesById.mockReset();
  mockSearchSecuritiesById.mockImplementation(async () => []);
});

describe("searchSnapshots", () => {
  test("runs both queries and merges results on the unfiltered global fetch", async () => {
    mockQuery
      .mockImplementationOnce(async () => ({ rows: [makeAccountRow()], rowCount: 1 }))
      .mockImplementationOnce(async () => ({ rows: [makeSecurityRow()], rowCount: 1 }));

    const result = await searchSnapshots(testUser, { startDate: "2026-01-01" });

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);

    const userScopedSql = mockQuery.mock.calls[0][0] as string;
    expect(userScopedSql).toContain("user_id = $1");
    expect(mockQuery.mock.calls[0][1]).toEqual(["usr-1", "2026-01-01"]);

    const securitySql = mockQuery.mock.calls[1][0] as string;
    expect(securitySql).not.toContain("user_id = ");
    expect(securitySql).toContain("snapshot_type = $1");
    expect(mockQuery.mock.calls[1][1]).toEqual(["security", "2026-01-01"]);
  });

  test("skips the security query when narrowing to a specific account_id", async () => {
    mockQuery.mockImplementationOnce(async () => ({
      rows: [makeAccountRow({ account_id: "acc-7" })],
      rowCount: 1,
    }));

    await searchSnapshots(testUser, { account_id: "acc-7" });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][1]).toContain("acc-7");
  });

  test("skips the security query when caller asks for snapshot_type='holding'", async () => {
    mockQuery.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));

    await searchSnapshots(testUser, { snapshot_type: "holding" });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("snapshot_type = ");
    expect(mockQuery.mock.calls[0][1]).toContain("holding");
  });

  test("skips the security query when caller passes a non-empty account_ids list", async () => {
    mockQuery.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));

    await searchSnapshots(testUser, { account_ids: ["acc-1", "acc-2"] });

    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test("runs the security query when caller explicitly asks for snapshot_type='security'", async () => {
    mockQuery
      .mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }))
      .mockImplementationOnce(async () => ({ rows: [makeSecurityRow()], rowCount: 1 }));

    const result = await searchSnapshots(testUser, { snapshot_type: "security" });

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ security: { security_id: "sec-aapl" } });
  });

  test("enriches security snapshots with ticker_symbol and name from the securities table", async () => {
    mockQuery
      .mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }))
      .mockImplementationOnce(async () => ({
        rows: [makeSecurityRow({ security_id: "sec-aapl", close_price: 195.5 })],
        rowCount: 1,
      }));
    mockSearchSecuritiesById.mockImplementationOnce(async () => [
      {
        security_id: "sec-aapl",
        ticker_symbol: "AAPL",
        name: "Apple Inc.",
        type: "equity",
        close_price: 200, // latest — should be OVERWRITTEN by the snapshot's historical price
        close_price_as_of: "2026-05-13",
      },
    ]);

    const result = await searchSnapshots(testUser, { startDate: "2026-01-01" });

    expect(mockSearchSecuritiesById).toHaveBeenCalledTimes(1);
    expect(mockSearchSecuritiesById.mock.calls[0][0]).toEqual(["sec-aapl"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      security: {
        security_id: "sec-aapl",
        ticker_symbol: "AAPL",
        name: "Apple Inc.",
        type: "equity",
        close_price: 195.5,
      },
    });
  });

  test("leaves security snapshot fields null when the securities table has no matching row", async () => {
    mockQuery
      .mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }))
      .mockImplementationOnce(async () => ({
        rows: [makeSecurityRow({ security_id: "sec-orphan" })],
        rowCount: 1,
      }));
    // mockSearchSecuritiesById returns [] by default — simulates orphan security

    const result = await searchSnapshots(testUser, { startDate: "2026-01-01" });

    expect(result).toHaveLength(1);
    const snap = result[0] as { security: { security_id: string; ticker_symbol?: string | null } };
    expect(snap.security.security_id).toBe("sec-orphan");
    expect(snap.security.ticker_symbol ?? null).toBeNull();
  });

  test("deduplicates security_ids before calling searchSecuritiesById", async () => {
    mockQuery
      .mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }))
      .mockImplementationOnce(async () => ({
        rows: [
          makeSecurityRow({ snapshot_id: "snap-1", security_id: "sec-aapl", snapshot_date: "2026-05-10" }),
          makeSecurityRow({ snapshot_id: "snap-2", security_id: "sec-aapl", snapshot_date: "2026-05-11" }),
          makeSecurityRow({ snapshot_id: "snap-3", security_id: "sec-msft", snapshot_date: "2026-05-10" }),
        ],
        rowCount: 3,
      }));

    await searchSnapshots(testUser, { startDate: "2026-01-01" });

    expect(mockSearchSecuritiesById).toHaveBeenCalledTimes(1);
    const ids = mockSearchSecuritiesById.mock.calls[0][0] as string[];
    expect(ids.sort()).toEqual(["sec-aapl", "sec-msft"]);
  });

  test("does not call searchSecuritiesById when there are no security snapshots", async () => {
    mockQuery
      .mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }))
      .mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));

    await searchSnapshots(testUser, { startDate: "2026-01-01" });

    expect(mockSearchSecuritiesById).toHaveBeenCalledTimes(0);
  });

  test("propagates date range to both queries", async () => {
    mockQuery
      .mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }))
      .mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));

    await searchSnapshots(testUser, { startDate: "2026-01-01", endDate: "2026-06-30" });

    expect(mockQuery).toHaveBeenCalledTimes(2);
    const userValues = mockQuery.mock.calls[0][1] as unknown[];
    const securityValues = mockQuery.mock.calls[1][1] as unknown[];
    expect(userValues).toContain("2026-01-01");
    expect(userValues).toContain("2026-06-30");
    expect(securityValues).toContain("2026-01-01");
    expect(securityValues).toContain("2026-06-30");
  });

  test("passes security_id filter through to the global security query", async () => {
    mockQuery
      .mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }))
      .mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));

    await searchSnapshots(testUser, { security_id: "sec-aapl" });

    const securitySql = mockQuery.mock.calls[1][0] as string;
    expect(securitySql).toContain("security_id = ");
    expect(mockQuery.mock.calls[1][1]).toContain("sec-aapl");
  });
});
