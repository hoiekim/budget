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
  upsertEngineSuggestion,
  demoteEngineSuggestionsForTransaction,
  deleteUserConfirmedSuggestionForTransaction,
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

describe("getSuggestionsForTransaction", () => {
  test("user-scoped + ordered by confidence DESC", async () => {
    mockQuery.mockImplementationOnce(async () => ({
      rows: [
        {
          suggestion_id: "s-1",
          transaction_id: "tx-1",
          user_id: "u-1",
          category_id: "cat-A",
          confidence: 1.0,
          updated: "2026-06-07T00:00:00Z",
        },
        {
          suggestion_id: "s-2",
          transaction_id: "tx-1",
          user_id: "u-1",
          category_id: "cat-B",
          confidence: 0,
          updated: "2026-06-07T00:00:00Z",
        },
      ],
      rowCount: 2,
    }));

    const result = await getSuggestionsForTransaction(fakeUser(), "tx-1");

    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/user_id\s*=\s*\$1/);
    expect(sql).toMatch(/transaction_id\s*=\s*\$2/);
    expect(sql).toMatch(/ORDER BY\s+confidence\s+DESC/);
    expect(values).toEqual(["u-1", "tx-1"]);
    expect(result).toHaveLength(2);
    expect(result[0].confidence).toBe(1.0);
    expect(result[1].confidence).toBe(0);
  });
});

describe("getSuggestionsForTransactions", () => {
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

describe("upsertUserConfirmedSuggestion", () => {
  test("forces confidence = 1 regardless of prior state — ON CONFLICT DO UPDATE on (transaction_id, category_id)", async () => {
    mockQuery.mockImplementationOnce(async () => ({
      rows: [
        {
          suggestion_id: "s-new",
          transaction_id: "tx-1",
          user_id: "u-1",
          category_id: "cat-A",
          confidence: 1,
          updated: "2026-06-07T00:00:00Z",
        },
      ],
      rowCount: 1,
    }));

    const result = await upsertUserConfirmedSuggestion(fakeUser(), "tx-1", "cat-A");

    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO suggestions/);
    expect(sql).toMatch(/ON CONFLICT \(transaction_id,\s*category_id\)/);
    expect(sql).toMatch(/DO UPDATE SET confidence = 1/);
    // user_id WHERE guard — defense-in-depth so an upsert can't ever clobber
    // a different user's row even if transaction_id collides.
    expect(sql).toMatch(/suggestions\.user_id\s*=\s*\$2/);
    expect(values).toEqual(["tx-1", "u-1", "cat-A"]);
    expect(result?.confidence).toBe(1);
  });
});

describe("upsertEngineSuggestion", () => {
  test("rejects non-strict-fractional confidence", async () => {
    await expect(
      upsertEngineSuggestion(fakeUser(), "tx-1", "cat-A", 1),
    ).rejects.toThrow(/strict-fractional/);
    await expect(
      upsertEngineSuggestion(fakeUser(), "tx-1", "cat-A", 0),
    ).rejects.toThrow(/strict-fractional/);
  });

  test("WHERE clause keeps engine from clobbering user-confirmed (=1) or user-rejected (=0) rows + scopes by user_id", async () => {
    mockQuery.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));
    await upsertEngineSuggestion(fakeUser(), "tx-1", "cat-A", 0.85);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/ON CONFLICT \(transaction_id,\s*category_id\)/);
    expect(sql).toMatch(/suggestions\.user_id\s*=\s*\$2/);
    expect(sql).toMatch(/suggestions\.confidence\s*<\s*1/);
    expect(sql).toMatch(/suggestions\.confidence\s*>\s*0/);
  });
});

describe("demoteEngineSuggestionsForTransaction", () => {
  test("strict-fractional WHERE — confidence > 0 AND < 1 (preserves user rows at 0 and 1)", async () => {
    mockQuery.mockImplementationOnce(async () => ({ rows: [], rowCount: 2 }));
    const n = await demoteEngineSuggestionsForTransaction(fakeUser(), "tx-1");
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE suggestions/);
    expect(sql).toMatch(/SET confidence = 0/);
    expect(sql).toMatch(/confidence\s*<\s*1/);
    expect(sql).toMatch(/confidence\s*>\s*0/);
    expect(values).toEqual(["u-1", "tx-1"]);
    expect(n).toBe(2);
  });
});

describe("deleteUserConfirmedSuggestionForTransaction", () => {
  test("keys on (user_id, transaction_id, confidence = 1)", async () => {
    mockQuery.mockImplementationOnce(async () => ({ rows: [], rowCount: 1 }));
    const n = await deleteUserConfirmedSuggestionForTransaction(fakeUser(), "tx-1");
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM suggestions/);
    expect(sql).toMatch(/confidence\s*=\s*1/);
    expect(values).toEqual(["u-1", "tx-1"]);
    expect(n).toBe(1);
  });
});

describe("deleteAllSuggestionsForTransaction", () => {
  test("hard-deletes every row keyed on (user_id, transaction_id)", async () => {
    mockQuery.mockImplementationOnce(async () => ({ rows: [], rowCount: 3 }));
    const n = await deleteAllSuggestionsForTransaction("u-1", "tx-1");
    const [, values] = mockQuery.mock.calls[0];
    expect(values).toEqual(["u-1", "tx-1"]);
    expect(n).toBe(3);
  });
});
