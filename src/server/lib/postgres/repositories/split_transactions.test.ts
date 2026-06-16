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

const { searchSplitTransactions } = await import("./split_transactions");

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
  mockQuery.mockReset();
});

describe("searchSplitTransactions", () => {
  test("defaults to active-only (excludeDeleted when includeDeleted unset)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await searchSplitTransactions(testUser);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("is_deleted IS NULL OR is_deleted = FALSE");
  });

  test("includeDeleted=true drops the soft-delete predicate", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await searchSplitTransactions(testUser, { includeDeleted: true });
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).not.toContain("is_deleted IS NULL OR is_deleted = FALSE");
  });

  test("passes user_id and account_id filters", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await searchSplitTransactions(
      { user_id: "usr-99", username: "test" },
      { account_id: "acc-specific" },
    );
    const values = mockQuery.mock.calls[0][1] as string[];
    expect(values).toContain("usr-99");
    expect(values).toContain("acc-specific");
  });

  test("applies date range on UPDATED column when provided", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await searchSplitTransactions(testUser, {
      startDate: "2026-03-01",
      endDate: "2026-04-01",
    });
    const sql = mockQuery.mock.calls[0][0] as string;
    const values = mockQuery.mock.calls[0][1] as string[];
    expect(sql).toContain("updated");
    expect(values).toContain("2026-03-01");
    expect(values).toContain("2026-04-01");
  });

  test("toJSON emits is_deleted alongside the existing fields", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeSplitRow({ is_deleted: true })],
      rowCount: 1,
    });
    const result = await searchSplitTransactions(testUser, { includeDeleted: true });
    expect(result).toHaveLength(1);
    expect(result[0].is_deleted).toBe(true);
    expect(result[0].split_transaction_id).toBe("split-1");
  });

  test("returns is_deleted=false for active rows when column is null/missing", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeSplitRow({ is_deleted: null })],
      rowCount: 1,
    });
    const result = await searchSplitTransactions(testUser);
    expect(result[0].is_deleted).toBe(false);
  });
});
