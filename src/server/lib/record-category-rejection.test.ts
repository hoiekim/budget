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

const { recordCategoryRejection } = await import("./record-category-rejection");

const user = { user_id: "u-1", username: "alice" } as unknown as Parameters<
  typeof recordCategoryRejection
>[0];

afterAll(restoreLeaves);

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
});

const findInsertRejection = () =>
  mockQuery.mock.calls.find((c) => /INSERT INTO rejected_categories/i.test(c[0]));
const findDeleteRejection = () =>
  mockQuery.mock.calls.find((c) => /DELETE FROM rejected_categories/i.test(c[0]));

describe("recordCategoryRejection — disambiguation rules", () => {
  test("no category change in request → no DB call (memo-only / budget-only update is a no-op for this mirror)", async () => {
    await recordCategoryRejection(user, "tx-1", { memo: "groceries" }, "cat-A");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("undefined reqLabel → no DB call", async () => {
    await recordCategoryRejection(user, "tx-1", undefined, "cat-A");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("BUDGET SWITCH disambiguation: budget_id set + category_id=null → NOT a rejection, no write", async () => {
    // FE flow when user switches budget: budget_id changes + category_id
    // clears (categories belong to budgets). Must NOT be logged as a
    // rejection — Hoie's daily-ops cron specifically called this out.
    await recordCategoryRejection(
      user,
      "tx-1",
      { budget_id: "budget-B", category_id: null },
      "cat-A",
    );
    expect(findInsertRejection()).toBeUndefined();
    expect(findDeleteRejection()).toBeUndefined();
  });

  test("genuine rejection: category_id=null without budget change AND prev was non-null → addRejectedCategory(prev)", async () => {
    await recordCategoryRejection(user, "tx-1", { category_id: null }, "cat-A");
    const insert = findInsertRejection();
    expect(insert).toBeDefined();
    expect(insert![1]).toEqual(["tx-1", "u-1", "cat-A"]);
    expect(insert![0]).toMatch(
      /VALUES\s*\(\$1,\s*\$2,\s*\$3\)\s*ON CONFLICT\s*\(transaction_id,\s*category_id\)/,
    );
  });

  test("no rejection if prev category was null — nothing concrete to record", async () => {
    await recordCategoryRejection(user, "tx-1", { category_id: null }, null);
    expect(findInsertRejection()).toBeUndefined();
  });

  test("CONFIRMATION cleanup: picking a category clears any prior rejection of THAT category", async () => {
    await recordCategoryRejection(user, "tx-1", { category_id: "cat-B" }, "cat-A");
    const del = findDeleteRejection();
    expect(del).toBeDefined();
    expect(del![1]).toEqual(["u-1", "tx-1", "cat-B"]);
    // Should NOT also try to add a rejection for the previous category — picking
    // B over A is not a rejection of A per Hoie's "no phantom rejection" rule.
    expect(findInsertRejection()).toBeUndefined();
  });

  test("CONFIRMATION cleanup also fires when picking the same category back (changed-my-mind cycle)", async () => {
    // User rejected cat-A earlier, now picks cat-A explicitly → the prior
    // rejection row for cat-A should be DELETE'd.
    await recordCategoryRejection(user, "tx-1", { category_id: "cat-A" }, null);
    const del = findDeleteRejection();
    expect(del).toBeDefined();
    expect(del![1]).toEqual(["u-1", "tx-1", "cat-A"]);
  });

  test("rejection write is keyed on (user_id, transaction_id, prev_category_id) — multi-user safety", async () => {
    await recordCategoryRejection(user, "tx-1", { category_id: null }, "cat-A");
    const insert = findInsertRejection();
    expect(insert).toBeDefined();
    expect(insert![0]).toMatch(/rejected_categories\.user_id\s*=\s*\$2/);
  });
});
