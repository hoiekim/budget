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
  addRejectedCategory,
  removeRejectedCategory,
  getRejectedCategoriesForTransactions,
} = await import("./rejected-categories");

const fakeUser = () =>
  ({
    user_id: "u-1",
    username: "alice",
  }) as unknown as Parameters<typeof addRejectedCategory>[0];

afterAll(restoreLeaves);

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
});

const fakeRow = (overrides: Record<string, unknown> = {}) => ({
  transaction_id: "tx-1",
  user_id: "u-1",
  category_id: "cat-A",
  rejected_at: "2026-06-09T13:00:00Z",
  ...overrides,
});

// NOTE — All assertions in this file are SQL-string shape checks against
// the mocked pg pool. They document the contracts the helpers are
// designed to produce; behavioral coverage of the composite-PK UPSERT
// happens at the live sandbox spin (per the PR's verification step).
// Stage 2 will replace these with integration tests once the table is
// wired into the route layer.

describe("addRejectedCategory [SQL-shape]", () => {
  test("INSERT … ON CONFLICT DO UPDATE refreshes rejected_at — composite-PK upsert", async () => {
    mockQuery.mockImplementationOnce(async () => ({
      rows: [fakeRow({ rejected_at: "now" })],
      rowCount: 1,
    }));
    const result = await addRejectedCategory(fakeUser(), "tx-1", "cat-A");
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO rejected_categories/);
    expect(sql).toMatch(
      /\(\s*transaction_id,\s+user_id,\s+category_id\s*\)\s*VALUES\s*\(\$1,\s*\$2,\s*\$3\)/,
    );
    expect(sql).toMatch(/ON CONFLICT \(transaction_id,\s*category_id\)/);
    expect(sql).toMatch(/DO UPDATE SET\s+rejected_at\s*=\s*CURRENT_TIMESTAMP/);
    expect(sql).toMatch(/rejected_categories\.user_id\s*=\s*\$2/);
    expect(values).toEqual(["tx-1", "u-1", "cat-A"]);
    expect(result?.transaction_id).toBe("tx-1");
    expect(result?.category_id).toBe("cat-A");
  });
});

describe("removeRejectedCategory [SQL-shape]", () => {
  test("DELETE scoped on (user_id, transaction_id, category_id) — used when user changes their mind", async () => {
    mockQuery.mockImplementationOnce(async () => ({ rows: [], rowCount: 1 }));
    const n = await removeRejectedCategory(fakeUser(), "tx-1", "cat-A");
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM rejected_categories/);
    expect(sql).toMatch(/user_id\s*=\s*\$1/);
    expect(sql).toMatch(/transaction_id\s*=\s*\$2/);
    expect(sql).toMatch(/category_id\s*=\s*\$3/);
    expect(values).toEqual(["u-1", "tx-1", "cat-A"]);
    expect(n).toBe(1);
  });

  test("returns 0 when no row matched", async () => {
    mockQuery.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));
    const n = await removeRejectedCategory(fakeUser(), "tx-nope", "cat-nope");
    expect(n).toBe(0);
  });
});

describe("getRejectedCategoriesForTransactions [SQL-shape]", () => {
  test("short-circuits when transaction_ids is empty (no DB call)", async () => {
    const result = await getRejectedCategoriesForTransactions(fakeUser(), []);
    expect(result).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("placeholders shift by 1 for user_id at $1, ORDER BY ensures stable read order", async () => {
    mockQuery.mockImplementationOnce(async () => ({
      rows: [fakeRow({ transaction_id: "tx-1" }), fakeRow({ transaction_id: "tx-2" })],
      rowCount: 2,
    }));
    const result = await getRejectedCategoriesForTransactions(fakeUser(), [
      "tx-1",
      "tx-2",
      "tx-3",
    ]);
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/SELECT\s+transaction_id,\s+user_id,\s+category_id,\s+rejected_at/);
    expect(sql).toMatch(/\$2,\s*\$3,\s*\$4/);
    expect(sql).toMatch(/ORDER BY\s+transaction_id,\s+rejected_at\s+DESC/);
    expect(values).toEqual(["u-1", "tx-1", "tx-2", "tx-3"]);
    expect(result).toHaveLength(2);
  });

  test("model maps row → toJSON shape with rejected_at preserved", async () => {
    mockQuery.mockImplementationOnce(async () => ({
      rows: [fakeRow({ rejected_at: "2026-06-09T13:00:00Z" })],
      rowCount: 1,
    }));
    const result = await getRejectedCategoriesForTransactions(fakeUser(), ["tx-1"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      transaction_id: "tx-1",
      category_id: "cat-A",
      rejected_at: "2026-06-09T13:00:00Z",
    });
  });
});
