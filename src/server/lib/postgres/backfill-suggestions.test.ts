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

const { backfillSuggestionsFromLegacyColumns } = await import("./backfill-suggestions");

afterAll(restoreLeaves);

beforeEach(() => {
  mockQuery.mockReset();
});

const respondWithLegacyColumn = (has_transactions: boolean) =>
  mockQuery.mockImplementationOnce(async () => ({
    rows: [{ has_transactions }],
    rowCount: 1,
  }));

describe("backfillSuggestionsFromLegacyColumns", () => {
  test("no-op when legacy `transactions.label_category_id` column is absent", async () => {
    respondWithLegacyColumn(false);
    await backfillSuggestionsFromLegacyColumns();
    // only the existence probe should run — no INSERT
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test("idempotent — ON CONFLICT (transaction_id, category_id) DO NOTHING", async () => {
    respondWithLegacyColumn(true);
    mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    await backfillSuggestionsFromLegacyColumns();

    expect(mockQuery).toHaveBeenCalledTimes(2);
    const insertSql = mockQuery.mock.calls[1][0];
    expect(insertSql).toMatch(/INSERT INTO suggestions/);
    expect(insertSql).toMatch(
      /ON CONFLICT \(transaction_id,\s*category_id\) DO NOTHING/,
    );
  });

  test("confidence defaults to 1.0 when `label_category_confidence` is NULL (user-set without engine score)", async () => {
    respondWithLegacyColumn(true);
    mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    await backfillSuggestionsFromLegacyColumns();

    const insertSql = mockQuery.mock.calls[1][0];
    expect(insertSql).toMatch(/COALESCE\(label_category_confidence,\s*1\.0\)/);
  });

  test("source-row guard — skips rows with NULL category (no engine signal possible)", async () => {
    respondWithLegacyColumn(true);
    mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    await backfillSuggestionsFromLegacyColumns();

    const insertSql = mockQuery.mock.calls[1][0];
    expect(insertSql).toMatch(/label_category_id IS NOT NULL/);
    // budget-only / memo-only legacy rows are intentionally excluded
    expect(insertSql).not.toMatch(/label_budget_id IS NOT NULL/);
    expect(insertSql).not.toMatch(/label_memo IS NOT NULL/);
  });

  test("skips soft-deleted parent transactions", async () => {
    respondWithLegacyColumn(true);
    mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    await backfillSuggestionsFromLegacyColumns();

    const insertSql = mockQuery.mock.calls[1][0];
    expect(insertSql).toMatch(/is_deleted IS NULL OR is_deleted = FALSE/);
  });

  test("inserts the explicit-flag columns — is_confirmed=TRUE, confirmed_at=transactions.updated", async () => {
    respondWithLegacyColumn(true);
    mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    await backfillSuggestionsFromLegacyColumns();

    const insertSql = mockQuery.mock.calls[1][0];
    // Column list: transaction_id, user_id, category_id, confidence,
    // is_confirmed, confirmed_at. No parent_type, no budget_id, no memo.
    expect(insertSql).toMatch(
      /INSERT INTO suggestions[\s\S]*\(transaction_id, user_id, category_id, confidence,[\s\S]*is_confirmed, confirmed_at\)/,
    );
    // SELECT projects TRUE for is_confirmed and transactions.updated for confirmed_at.
    expect(insertSql).toMatch(/TRUE,\s*updated/);
    expect(insertSql).not.toMatch(/parent_type/);
    expect(insertSql).not.toMatch(/parent_id/);
    expect(insertSql).not.toMatch(/\bmemo\b/);
    expect(insertSql).not.toMatch(/label_budget_id/);
  });
});
