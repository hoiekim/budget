import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";

const { driver, mockUnsafe, resetSqlMocks } = createFakeSql();

mock.module("../sql-driver", () => driver);

const { searchSplitTransactions, repointSplitTransactionsOnPendingPosted } = await import(
  "./split_transactions"
);

afterAll(restoreLeaves);

function makeSplitRow(overrides: Record<string, unknown> = {}) {
  return {
    split_transaction_id: "split-1",
    user_id: "usr-1",
    transaction_id: "tx-1",
    account_id: "acc-1",
    amount: 12.5,
    date: "2026-03-01",
    custom_name: "groceries portion",
    label_budget_id: null,
    label_category_id: null,
    label_memo: null,
    label_category_confidence: null,
    updated: "2026-03-01T00:00:00Z",
    is_deleted: false,
    ...overrides,
  };
}

const testUser = { user_id: "usr-1", username: "hoie" };

beforeEach(() => {
  resetSqlMocks();
});

describe("searchSplitTransactions", () => {
  test("defaults to active-only (excludeDeleted when includeDeleted unset)", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await searchSplitTransactions(testUser);
    const sql = mockUnsafe.mock.calls[0][0] as string;
    expect(sql).toContain("is_deleted IS NULL OR is_deleted = FALSE");
  });

  test("includeDeleted=true drops the soft-delete predicate", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await searchSplitTransactions(testUser, { includeDeleted: true });
    const sql = mockUnsafe.mock.calls[0][0] as string;
    expect(sql).not.toContain("is_deleted IS NULL OR is_deleted = FALSE");
  });

  test("passes user_id and account_id filters", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await searchSplitTransactions(
      { user_id: "usr-99", username: "test" },
      { account_id: "acc-specific" },
    );
    const values = mockUnsafe.mock.calls[0][1] as string[];
    expect(values).toContain("usr-99");
    expect(values).toContain("acc-specific");
  });

  test("applies date range on UPDATED column when provided", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await searchSplitTransactions(testUser, {
      startDate: "2026-03-01",
      endDate: "2026-04-01",
    });
    const sql = mockUnsafe.mock.calls[0][0] as string;
    const values = mockUnsafe.mock.calls[0][1] as string[];
    expect(sql).toContain("updated");
    expect(values).toContain("2026-03-01");
    expect(values).toContain("2026-04-01");
  });

  test("toJSON emits is_deleted alongside the existing fields", async () => {
    mockUnsafe.mockResolvedValueOnce({
      rows: [makeSplitRow({ is_deleted: true })],
      rowCount: 1,
    });
    const result = await searchSplitTransactions(testUser, { includeDeleted: true });
    expect(result).toHaveLength(1);
    expect(result[0].is_deleted).toBe(true);
    expect(result[0].split_transaction_id).toBe("split-1");
  });

  test("returns is_deleted=false for active rows when column is null/missing", async () => {
    mockUnsafe.mockResolvedValueOnce({
      rows: [makeSplitRow({ is_deleted: null })],
      rowCount: 1,
    });
    const result = await searchSplitTransactions(testUser);
    expect(result[0].is_deleted).toBe(false);
  });
});

describe("repointSplitTransactionsOnPendingPosted", () => {
  test("UPDATE re-points live splits to the posted id, scoped to the user", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // guard: no live splits on posted id
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 2 });
    const n = await repointSplitTransactionsOnPendingPosted(testUser, "tx-pending", "tx-posted");
    expect(mockUnsafe).toHaveBeenCalledTimes(2);
    const guardSql = mockUnsafe.mock.calls[0][0] as string;
    expect(guardSql).toMatch(/SELECT 1 FROM split_transactions/);
    expect((mockUnsafe.mock.calls[0][1] as string[]).slice(0, 2)).toEqual(["usr-1", "tx-posted"]);
    const sql = mockUnsafe.mock.calls[1][0] as string;
    const values = mockUnsafe.mock.calls[1][1] as string[];
    expect(sql).toMatch(/UPDATE split_transactions/);
    expect(sql).toMatch(/SET\s+transaction_id\s*=\s*\$3/);
    expect(sql).toMatch(/updated\s*=\s*CURRENT_TIMESTAMP/);
    expect(sql).toMatch(/user_id\s*=\s*\$1/);
    expect(sql).toMatch(/transaction_id\s*=\s*\$2/);
    expect(sql).toMatch(/is_deleted IS NULL OR is_deleted = FALSE/);
    expect(values).toEqual(["usr-1", "tx-pending", "tx-posted"]);
    expect(n).toBe(2);
  });

  test("returns 0 when no live split matched", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // guard: no live splits on posted id
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const n = await repointSplitTransactionsOnPendingPosted(testUser, "tx-pending", "tx-posted");
    expect(n).toBe(0);
  });

  test("no-op without issuing a query when pending and posted ids match", async () => {
    const n = await repointSplitTransactionsOnPendingPosted(testUser, "tx-same", "tx-same");
    expect(n).toBe(0);
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("skips the UPDATE when the posted id already has live splits", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [{ "1": 1 }], rowCount: 1 }); // guard: live splits exist
    const n = await repointSplitTransactionsOnPendingPosted(testUser, "tx-pending", "tx-posted");
    expect(n).toBe(0);
    expect(mockUnsafe).toHaveBeenCalledTimes(1);
    const guardSql = mockUnsafe.mock.calls[0][0] as string;
    expect(guardSql).toMatch(/SELECT 1 FROM split_transactions/);
    expect(guardSql).toMatch(/is_deleted IS NULL OR is_deleted = FALSE/);
  });

  test("guard SELECT is scoped to the posted id and live rows only", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // guard: no live splits on posted id
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await repointSplitTransactionsOnPendingPosted(testUser, "tx-pending", "tx-posted");
    const guardSql = mockUnsafe.mock.calls[0][0] as string;
    const guardValues = mockUnsafe.mock.calls[0][1] as string[];
    expect(guardSql).toMatch(/transaction_id\s*=\s*\$2/);
    expect(guardSql).toMatch(/LIMIT 1/);
    expect(guardValues).toEqual(["usr-1", "tx-posted"]);
  });
});
