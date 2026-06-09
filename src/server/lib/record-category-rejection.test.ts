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

const fakeUser = () =>
  ({
    user_id: "u-1",
    username: "alice",
  }) as unknown as Parameters<typeof recordCategoryRejection>[0];

const prev = (overrides: Partial<{ category_id: string | null; budget_id: string | null }> = {}) => ({
  category_id: null,
  budget_id: null,
  ...overrides,
});

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
    await recordCategoryRejection(fakeUser(), "tx-1", { memo: "groceries" }, prev({ category_id: "cat-A" }));
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("undefined reqLabel → no DB call", async () => {
    await recordCategoryRejection(fakeUser(), "tx-1", undefined, prev({ category_id: "cat-A" }));
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("BUDGET SWITCH disambiguation: budget_id CHANGES + category_id=null → NOT a rejection, no write", async () => {
    // FE flow when user switches budget: budget_id changes + category_id
    // clears (categories belong to budgets). Must NOT be logged as a
    // rejection — Hoie's daily-ops cron specifically called this out.
    await recordCategoryRejection(
      fakeUser(),
      "tx-1",
      { budget_id: "budget-B", category_id: null },
      prev({ category_id: "cat-A", budget_id: "budget-A" }),
    );
    expect(findInsertRejection()).toBeUndefined();
    expect(findDeleteRejection()).toBeUndefined();
  });

  test("BUDGET-UNCHANGED rejection: body re-states current budget_id + category_id=null → still a genuine rejection", async () => {
    // Defensive case (reviewer's MED #2): if the FE sends the unchanged
    // budget_id in the body alongside a category clear, this should NOT
    // be swallowed as a budget switch. Budget actually has to differ for
    // the disambiguation to fire.
    await recordCategoryRejection(
      fakeUser(),
      "tx-1",
      { budget_id: "budget-A", category_id: null },
      prev({ category_id: "cat-A", budget_id: "budget-A" }),
    );
    const insert = findInsertRejection();
    expect(insert).toBeDefined();
    expect(insert![1]).toEqual(["tx-1", "u-1", "cat-A"]);
  });

  test("genuine rejection: category_id=null without budget change AND prev was non-null → addRejectedCategory(prev)", async () => {
    await recordCategoryRejection(fakeUser(), "tx-1", { category_id: null }, prev({ category_id: "cat-A" }));
    const insert = findInsertRejection();
    expect(insert).toBeDefined();
    expect(insert![1]).toEqual(["tx-1", "u-1", "cat-A"]);
    expect(insert![0]).toMatch(
      /VALUES\s*\(\$1,\s*\$2,\s*\$3\)\s*ON CONFLICT\s*\(transaction_id,\s*category_id\)/,
    );
  });

  test("no rejection if prev category was null — nothing concrete to record", async () => {
    await recordCategoryRejection(fakeUser(), "tx-1", { category_id: null }, prev({ category_id: null }));
    expect(findInsertRejection()).toBeUndefined();
  });

  test("CONFIRMATION cleanup: picking a category clears any prior rejection of THAT category", async () => {
    await recordCategoryRejection(fakeUser(), "tx-1", { category_id: "cat-B" }, prev({ category_id: "cat-A" }));
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
    await recordCategoryRejection(fakeUser(), "tx-1", { category_id: "cat-A" }, prev({ category_id: null }));
    const del = findDeleteRejection();
    expect(del).toBeDefined();
    expect(del![1]).toEqual(["u-1", "tx-1", "cat-A"]);
  });

  test("rejection write is keyed on (user_id, transaction_id, prev_category_id) — multi-user safety", async () => {
    await recordCategoryRejection(fakeUser(), "tx-1", { category_id: null }, prev({ category_id: "cat-A" }));
    const insert = findInsertRejection();
    expect(insert).toBeDefined();
    expect(insert![0]).toMatch(/rejected_categories\.user_id\s*=\s*\$2/);
  });
});
