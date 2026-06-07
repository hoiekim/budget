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

const { backfillLabelsFromLegacyColumns } = await import("./backfill-labels");

afterAll(restoreLeaves);

beforeEach(() => {
  mockQuery.mockReset();
});

const respondWithColumnsExisting = (has_transactions: boolean, has_accounts: boolean) =>
  mockQuery.mockImplementationOnce(async () => ({
    rows: [{ has_transactions, has_accounts }],
    rowCount: 1,
  }));

describe("backfillLabelsFromLegacyColumns", () => {
  test("no-op when both legacy columns are absent (post-Stage-3 deploy)", async () => {
    respondWithColumnsExisting(false, false);
    await backfillLabelsFromLegacyColumns();
    // only the existence probe should run
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test("idempotent path — ON CONFLICT DO NOTHING in both INSERTs", async () => {
    respondWithColumnsExisting(true, true);
    mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    await backfillLabelsFromLegacyColumns();

    // existence probe + transactions INSERT + accounts INSERT
    expect(mockQuery).toHaveBeenCalledTimes(3);
    const txnSql = mockQuery.mock.calls[1][0];
    const acctSql = mockQuery.mock.calls[2][0];
    expect(txnSql).toMatch(/INSERT INTO labels/);
    expect(txnSql).toMatch(/ON CONFLICT \(parent_id,\s*confidence\) DO NOTHING/);
    expect(acctSql).toMatch(/INSERT INTO labels/);
    expect(acctSql).toMatch(/ON CONFLICT \(parent_id,\s*confidence\) DO NOTHING/);
  });

  test("transactions INSERT — confidence defaults to 1.0 when label_category_confidence is NULL", async () => {
    respondWithColumnsExisting(true, false);
    mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    await backfillLabelsFromLegacyColumns();

    const txnSql = mockQuery.mock.calls[1][0];
    expect(txnSql).toMatch(/COALESCE\(label_category_confidence,\s*1\.0\)/);
    // Source-row guard: skips fully-empty rows
    expect(txnSql).toMatch(/label_category_id IS NOT NULL/);
    expect(txnSql).toMatch(/label_budget_id IS NOT NULL/);
    expect(txnSql).toMatch(/label_memo IS NOT NULL/);
    // Skips soft-deleted parents
    expect(txnSql).toMatch(/is_deleted IS NULL OR is_deleted = FALSE/);
  });

  test("accounts INSERT — confidence pinned to 1.0 (no engine signal on accounts today)", async () => {
    respondWithColumnsExisting(false, true);
    mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    await backfillLabelsFromLegacyColumns();

    const acctSql = mockQuery.mock.calls[1][0];
    expect(acctSql).toMatch(/INSERT INTO labels/);
    expect(acctSql).toMatch(/'account'/);
    expect(acctSql).toMatch(/1\.0/);
    expect(acctSql).toMatch(/label_budget_id IS NOT NULL/);
  });

  test("runs both INSERTs when both columns exist", async () => {
    respondWithColumnsExisting(true, true);
    mockQuery
      .mockImplementationOnce(async () => ({ rows: [], rowCount: 42 }))
      .mockImplementationOnce(async () => ({ rows: [], rowCount: 7 }));
    await backfillLabelsFromLegacyColumns();

    expect(mockQuery).toHaveBeenCalledTimes(3);
    const [txnSql] = mockQuery.mock.calls[1];
    const [acctSql] = mockQuery.mock.calls[2];
    expect(txnSql).toMatch(/'transaction'/);
    expect(acctSql).toMatch(/'account'/);
  });
});
