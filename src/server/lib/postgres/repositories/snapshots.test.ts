import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";
import * as realSecurities from "./securities";

// Snapshot real `./securities` exports before partially overriding the
// module — the `repositories/index.ts` barrel re-exports * from this
// path, so sibling tests would see a partial module without the
// real-export spread.
const realSecuritiesSnap = { ...realSecurities };

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

const mockSearchSecuritiesById = mock(async (_ids: string[]) => [] as unknown[]);
mock.module("./securities", () => ({
  ...realSecuritiesSnap,
  searchSecuritiesById: mockSearchSecuritiesById,
}));

const { searchSnapshots } = await import("./snapshots");

afterAll(() => {
  mock.module("./securities", () => realSecuritiesSnap);
  restoreLeaves();
});

const testUser = { user_id: "usr-1", username: "hoie" };

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

  test("skips the security query when narrowing to a specific account_id (still runs the holding_account_id query — see #445)", async () => {
    mockQuery
      .mockImplementationOnce(async () => ({
        rows: [makeAccountRow({ account_id: "acc-7" })],
        rowCount: 1,
      }))
      .mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));

    await searchSnapshots(testUser, { account_id: "acc-7" });

    // 1 = account_id-scoped, 2 = holding_account_id-scoped (#445 fix).
    // No 3rd call for global security.
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[0][1]).toContain("acc-7");
    const secondSql = mockQuery.mock.calls[1][0] as string;
    expect(secondSql).toContain("holding_account_id = ");
  });

  test("skips the security query when caller asks for snapshot_type='holding'", async () => {
    mockQuery.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));

    await searchSnapshots(testUser, { snapshot_type: "holding" });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("snapshot_type = ");
    expect(mockQuery.mock.calls[0][1]).toContain("holding");
  });

  test("skips the security query when caller passes a non-empty account_ids list (still runs the holding_account_id query — see #445)", async () => {
    mockQuery
      .mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }))
      .mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));

    await searchSnapshots(testUser, { account_ids: ["acc-1", "acc-2"] });

    expect(mockQuery).toHaveBeenCalledTimes(2);
    const secondSql = mockQuery.mock.calls[1][0] as string;
    expect(secondSql).toContain("holding_account_id IN");
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
        close_price: 200,
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
          makeSecurityRow({
            snapshot_id: "snap-1",
            security_id: "sec-aapl",
            snapshot_date: "2026-05-10",
          }),
          makeSecurityRow({
            snapshot_id: "snap-2",
            security_id: "sec-aapl",
            snapshot_date: "2026-05-11",
          }),
          makeSecurityRow({
            snapshot_id: "snap-3",
            security_id: "sec-msft",
            snapshot_date: "2026-05-10",
          }),
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

describe("searchSnapshots — #445 holding_account_id regression", () => {
  test("when account_id is set, also queries holdings via holding_account_id", async () => {
    // First call: account_id-scoped (returns empty — historical bug: holdings'
    // account_id is NULL so this never returns holding rows).
    // Second call: holding_account_id-scoped (this is the fix; returns the
    // brokerage's holding snapshots).
    mockQuery
      .mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }))
      .mockImplementationOnce(async () => ({
        rows: [
          makeBaseRow({
            snapshot_id: "snap-h1",
            user_id: "usr-1",
            snapshot_type: "holding",
            account_id: null,
            holding_account_id: "acc-brokerage",
            holding_security_id: "sec-voo",
            institution_value: 329310.97,
            quantity: 472.26584,
          }),
        ],
        rowCount: 1,
      }));

    const result = await searchSnapshots(testUser, { account_id: "acc-brokerage" });

    // Two queries — the second is the new holding_account_id branch.
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const holdingSql = mockQuery.mock.calls[1][0] as string;
    const holdingValues = mockQuery.mock.calls[1][1] as unknown[];
    expect(holdingSql).toContain("holding_account_id = ");
    expect(holdingSql).toContain("snapshot_type = ");
    expect(holdingValues).toContain("acc-brokerage");
    expect(holdingValues).toContain("holding");

    // The holding snapshot lands in the result set.
    expect(result).toHaveLength(1);
    // JSONSnapshotData is a discriminated union — JSONHoldingSnapshot has
    // a top-level `holding` field. Check that the holding row mapped into
    // a holding-shaped snapshot, not an account/security one.
    expect("holding" in result[0]).toBe(true);
    expect((result[0] as { holding: { account_id: string } }).holding.account_id).toBe(
      "acc-brokerage",
    );
  });

  test("when account_ids[] is set, also queries holdings via holding_account_id IN (...)", async () => {
    mockQuery
      .mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }))
      .mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));

    await searchSnapshots(testUser, { account_ids: ["acc-a", "acc-b"] });

    expect(mockQuery).toHaveBeenCalledTimes(2);
    const holdingSql = mockQuery.mock.calls[1][0] as string;
    const holdingValues = mockQuery.mock.calls[1][1] as unknown[];
    expect(holdingSql).toContain("holding_account_id IN");
    expect(holdingValues).toContain("acc-a");
    expect(holdingValues).toContain("acc-b");
  });

  test("when snapshot_type is explicitly 'holding' and account_id is set, the holding_account_id query runs", async () => {
    mockQuery
      .mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }))
      .mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));

    await searchSnapshots(testUser, { snapshot_type: "holding", account_id: "acc-x" });

    expect(mockQuery).toHaveBeenCalledTimes(2);
    const holdingSql = mockQuery.mock.calls[1][0] as string;
    expect(holdingSql).toContain("holding_account_id = ");
  });

  test("when snapshot_type is 'account_balance' and account_id is set, the holding query is skipped", async () => {
    mockQuery.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));

    await searchSnapshots(testUser, { snapshot_type: "account_balance", account_id: "acc-x" });

    // Only the user-scoped query runs. No holding branch, no security branch.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test("when no account narrowing is passed, the holding_account_id branch is skipped", async () => {
    mockQuery
      .mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }))
      .mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));

    await searchSnapshots(testUser, {});

    // 1 = user-scoped, 2 = global security. No holding-by-account query.
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const secondSql = mockQuery.mock.calls[1][0] as string;
    expect(secondSql).toContain("snapshot_type = ");
    expect(mockQuery.mock.calls[1][1]).toContain("security");
  });

  test("holding-by-account result is user-scoped to prevent cross-user leakage", async () => {
    mockQuery
      .mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }))
      .mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));

    await searchSnapshots(testUser, { account_id: "acc-x" });

    const holdingSql = mockQuery.mock.calls[1][0] as string;
    const holdingValues = mockQuery.mock.calls[1][1] as unknown[];
    expect(holdingSql).toContain("user_id = ");
    expect(holdingValues).toContain("usr-1");
  });

  test("date range is propagated to the holding_account_id query", async () => {
    mockQuery
      .mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }))
      .mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));

    await searchSnapshots(testUser, {
      account_id: "acc-x",
      startDate: "2026-01-01",
      endDate: "2026-06-30",
    });

    const holdingValues = mockQuery.mock.calls[1][1] as unknown[];
    expect(holdingValues).toContain("2026-01-01");
    expect(holdingValues).toContain("2026-06-30");
  });
});
