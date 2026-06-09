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

const {
  getSuggestionsForTransaction,
  getSuggestionsForTransactions,
  upsertUserConfirmedSuggestion,
  upsertUserRejectedSuggestion,
  upsertEngineSuggestion,
  deleteAllSuggestionsForTransaction,
} = await import("./suggestions");

const fakeUser = () =>
  ({
    user_id: "u-1",
    username: "alice",
  }) as unknown as Parameters<typeof getSuggestionsForTransaction>[0];

afterAll(restoreLeaves);

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
});

const fakeRow = (overrides: Record<string, unknown> = {}) => ({
  transaction_id: "tx-1",
  user_id: "u-1",
  category_id: "cat-A",
  confidence: 1,
  is_confirmed: false,
  is_rejected: false,
  confirmed_at: null,
  engine_scored_at: null,
  updated: "2026-06-09T00:00:00Z",
  ...overrides,
});

// NOTE — All assertions in this file are SQL-string shape checks against the
// mocked pg pool. They document the contracts the helpers are designed to
// produce, but do NOT execute the ON CONFLICT / WHERE guards in a real
// Postgres. Behavioral coverage of the engine-doesn't-clobber-user-row
// invariant is provided by the live sandbox spin in PR #496's verification
// step (6112 backfilled rows, schema confirmed via `\d suggestions`).
// Stage 2 will replace these with integration tests once the table is wired.

describe("getSuggestionsForTransaction [SQL-shape]", () => {
  test("user-scoped + ordered by is_confirmed DESC then confidence DESC", async () => {
    mockQuery.mockImplementationOnce(async () => ({
      rows: [fakeRow({ category_id: "cat-A", confidence: 1, is_confirmed: true })],
      rowCount: 1,
    }));
    await getSuggestionsForTransaction(fakeUser(), "tx-1");
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/user_id\s*=\s*\$1/);
    expect(sql).toMatch(/transaction_id\s*=\s*\$2/);
    expect(sql).toMatch(/ORDER BY\s+is_confirmed\s+DESC,\s+confidence\s+DESC/);
    expect(values).toEqual(["u-1", "tx-1"]);
  });
});

describe("getSuggestionsForTransactions [SQL-shape]", () => {
  test("short-circuits when transaction_ids is empty (no DB call)", async () => {
    const result = await getSuggestionsForTransactions(fakeUser(), []);
    expect(result).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("placeholders shift by 1 to account for user_id at $1", async () => {
    await getSuggestionsForTransactions(fakeUser(), ["tx-1", "tx-2", "tx-3"]);
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/\$2,\s*\$3,\s*\$4/);
    expect(values).toEqual(["u-1", "tx-1", "tx-2", "tx-3"]);
  });
});

describe("upsertUserConfirmedSuggestion [SQL-shape]", () => {
  test("sets is_confirmed=TRUE, is_rejected=FALSE, confirmed_at=NOW(), confidence=1 on insert", async () => {
    mockQuery.mockImplementationOnce(async () => ({
      rows: [fakeRow({ is_confirmed: true, confidence: 1, confirmed_at: "now" })],
      rowCount: 1,
    }));
    const result = await upsertUserConfirmedSuggestion(fakeUser(), "tx-1", "cat-A");
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO suggestions/);
    expect(sql).toMatch(/VALUES\s*\(\$1,\s*\$2,\s*\$3,\s*1,\s*TRUE,\s*FALSE,\s*CURRENT_TIMESTAMP\)/);
    expect(sql).toMatch(/ON CONFLICT \(transaction_id,\s*category_id\)/);
    expect(sql).toMatch(/is_confirmed\s*=\s*TRUE/);
    expect(sql).toMatch(/is_rejected\s*=\s*FALSE/);
    expect(sql).toMatch(/confirmed_at\s*=\s*CURRENT_TIMESTAMP/);
    expect(sql).toMatch(/suggestions\.user_id\s*=\s*\$2/);
    expect(values).toEqual(["tx-1", "u-1", "cat-A"]);
    expect(result?.is_confirmed).toBe(true);
  });
});

describe("upsertUserRejectedSuggestion [SQL-shape]", () => {
  test("sets is_rejected=TRUE, is_confirmed=FALSE", async () => {
    mockQuery.mockImplementationOnce(async () => ({
      rows: [fakeRow({ is_rejected: true, confidence: 0 })],
      rowCount: 1,
    }));
    const result = await upsertUserRejectedSuggestion(fakeUser(), "tx-1", "cat-A");
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO suggestions/);
    expect(sql).toMatch(/VALUES\s*\(\$1,\s*\$2,\s*\$3,\s*0,\s*FALSE,\s*TRUE\)/);
    expect(sql).toMatch(/is_rejected\s*=\s*TRUE/);
    expect(sql).toMatch(/is_confirmed\s*=\s*FALSE/);
    expect(values).toEqual(["tx-1", "u-1", "cat-A"]);
    expect(result?.is_rejected).toBe(true);
  });
});

describe("upsertEngineSuggestion [SQL-shape]", () => {
  test("rejects non-strict-fractional confidence", async () => {
    await expect(
      upsertEngineSuggestion(fakeUser(), "tx-1", "cat-A", 1),
    ).rejects.toThrow(/strict-fractional/);
    await expect(
      upsertEngineSuggestion(fakeUser(), "tx-1", "cat-A", 0),
    ).rejects.toThrow(/strict-fractional/);
  });

  test("ON CONFLICT WHERE clause guards user_id AND skips user-actioned rows (is_confirmed OR is_rejected)", async () => {
    mockQuery.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));
    await upsertEngineSuggestion(fakeUser(), "tx-1", "cat-A", 0.85);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO suggestions/);
    expect(sql).toMatch(/engine_scored_at.*CURRENT_TIMESTAMP/);
    expect(sql).toMatch(/ON CONFLICT \(transaction_id,\s*category_id\)/);
    expect(sql).toMatch(/suggestions\.user_id\s*=\s*\$2/);
    expect(sql).toMatch(/NOT suggestions\.is_confirmed/);
    expect(sql).toMatch(/NOT suggestions\.is_rejected/);
  });
});

describe("deleteAllSuggestionsForTransaction [SQL-shape]", () => {
  test("hard-deletes every row keyed on (user_id, transaction_id)", async () => {
    mockQuery.mockImplementationOnce(async () => ({ rows: [], rowCount: 3 }));
    const n = await deleteAllSuggestionsForTransaction("u-1", "tx-1");
    const [, values] = mockQuery.mock.calls[0];
    expect(values).toEqual(["u-1", "tx-1"]);
    expect(n).toBe(3);
  });
});
