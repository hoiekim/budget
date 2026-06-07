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
  getLabelsForParent,
  getLabelsForParents,
  upsertLabel,
  deleteEngineLabelsForParent,
  deleteLabel,
  deleteAllLabelsForParent,
} = await import("./labels");

const fakeUser = (overrides: Partial<{ user_id: string }> = {}) =>
  ({
    user_id: "u-1",
    username: "alice",
    ...overrides,
  }) as unknown as Parameters<typeof getLabelsForParent>[0];

afterAll(restoreLeaves);

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
});

describe("getLabelsForParent", () => {
  test("user-scopes the query + orders by confidence DESC", async () => {
    mockQuery.mockImplementationOnce(async () => ({
      rows: [
        {
          label_id: "l-1",
          parent_type: "transaction",
          parent_id: "tx-1",
          user_id: "u-1",
          budget_id: null,
          category_id: "cat-A",
          memo: null,
          confidence: 1.0,
          updated: "2026-06-07T00:00:00Z",
        },
        {
          label_id: "l-2",
          parent_type: "transaction",
          parent_id: "tx-1",
          user_id: "u-1",
          budget_id: null,
          category_id: "cat-B",
          memo: null,
          confidence: 0,
          updated: "2026-06-07T00:00:00Z",
        },
      ],
      rowCount: 2,
    }));

    const result = await getLabelsForParent(fakeUser(), "tx-1");

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/user_id\s*=\s*\$1/);
    expect(sql).toMatch(/parent_id\s*=\s*\$2/);
    expect(sql).toMatch(/ORDER BY\s+confidence\s+DESC/);
    expect(values).toEqual(["u-1", "tx-1"]);
    expect(result).toHaveLength(2);
    expect(result[0].confidence).toBe(1.0);
    expect(result[1].confidence).toBe(0);
  });
});

describe("getLabelsForParents", () => {
  test("short-circuits when parent_ids is empty (no DB call)", async () => {
    const result = await getLabelsForParents(fakeUser(), []);
    expect(result).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("placeholders shift by 1 to account for user_id at $1", async () => {
    await getLabelsForParents(fakeUser(), ["tx-1", "tx-2", "tx-3"]);
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/\$2,\s*\$3,\s*\$4/);
    expect(values).toEqual(["u-1", "tx-1", "tx-2", "tx-3"]);
  });
});

describe("upsertLabel", () => {
  test("ON CONFLICT (parent_id, confidence) DO UPDATE — engine re-suggest does not pile rows", async () => {
    mockQuery.mockImplementationOnce(async () => ({
      rows: [
        {
          label_id: "l-new",
          parent_type: "transaction",
          parent_id: "tx-1",
          user_id: "u-1",
          budget_id: null,
          category_id: "cat-A",
          memo: null,
          confidence: 0.85,
          updated: "2026-06-07T00:00:00Z",
        },
      ],
      rowCount: 1,
    }));

    const result = await upsertLabel(fakeUser(), {
      parent_type: "transaction",
      parent_id: "tx-1",
      budget_id: null,
      category_id: "cat-A",
      memo: null,
      confidence: 0.85,
    });

    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO labels/);
    expect(sql).toMatch(/ON CONFLICT \(parent_id,\s*confidence\)/);
    expect(sql).toMatch(/DO UPDATE SET/);
    expect(values).toEqual([
      "transaction",
      "tx-1",
      "u-1",
      null,
      "cat-A",
      null,
      0.85,
    ]);
    expect(result?.confidence).toBe(0.85);
  });
});

describe("deleteEngineLabelsForParent", () => {
  test("strict-fractional WHERE clause — confidence > 0 AND < 1 (preserves user rejection at 0 and confirmation at 1)", async () => {
    mockQuery.mockImplementationOnce(async () => ({ rows: [], rowCount: 2 }));
    const deleted = await deleteEngineLabelsForParent(fakeUser(), "tx-1");
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM labels/);
    expect(sql).toMatch(/confidence\s*>\s*0/);
    expect(sql).toMatch(/confidence\s*<\s*1/);
    expect(values).toEqual(["u-1", "tx-1"]);
    expect(deleted).toBe(2);
  });
});

describe("deleteLabel + deleteAllLabelsForParent", () => {
  test("deleteLabel keys on (user_id, parent_id, confidence)", async () => {
    mockQuery.mockImplementationOnce(async () => ({ rows: [], rowCount: 1 }));
    const ok = await deleteLabel(fakeUser(), "tx-1", 0);
    const [, values] = mockQuery.mock.calls[0];
    expect(values).toEqual(["u-1", "tx-1", 0]);
    expect(ok).toBe(true);
  });

  test("deleteLabel returns false when no row matched", async () => {
    mockQuery.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));
    const ok = await deleteLabel(fakeUser(), "tx-1", 0.5);
    expect(ok).toBe(false);
  });

  test("deleteAllLabelsForParent keys on (user_id, parent_id)", async () => {
    mockQuery.mockImplementationOnce(async () => ({ rows: [], rowCount: 3 }));
    const count = await deleteAllLabelsForParent("u-1", "tx-1");
    const [, values] = mockQuery.mock.calls[0];
    expect(values).toEqual(["u-1", "tx-1"]);
    expect(count).toBe(3);
  });
});
