import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";

const { driver, mockUnsafe, resetSqlMocks, clearSqlMocks } = createFakeSql();

mock.module("./postgres/sql-driver", () => driver);

const { recordCategoryRejection } = await import("./record-category-rejection");

const fakeUser = () =>
  ({
    user_id: "u-1",
    username: "alice",
  }) as unknown as Parameters<typeof recordCategoryRejection>[0];

const prev = (
  overrides: Partial<{
    category_id: string | null;
    budget_id: string | null;
    category_confidence: number | null;
  }> = {},
) => ({
  category_id: null,
  budget_id: null,
  category_confidence: null,
  ...overrides,
});

afterAll(restoreLeaves);

beforeEach(() => {
  resetSqlMocks();
  mockUnsafe.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
});

const findInsertRejection = () =>
  mockUnsafe.mock.calls.find((c) => /INSERT INTO rejected_categories/i.test(c[0]));
const findDeleteRejection = () =>
  mockUnsafe.mock.calls.find((c) => /DELETE FROM rejected_categories/i.test(c[0]));

describe("recordCategoryRejection — body shape gating", () => {
  test("no category change in request → no DB call", async () => {
    await recordCategoryRejection(
      fakeUser(),
      "tx-1",
      { memo: "groceries" },
      prev({ category_id: "cat-A", category_confidence: 1 }),
    );
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("undefined reqLabel → no DB call", async () => {
    await recordCategoryRejection(
      fakeUser(),
      "tx-1",
      undefined,
      prev({ category_id: "cat-A", category_confidence: 1 }),
    );
    expect(mockUnsafe).not.toHaveBeenCalled();
  });
});

describe("recordCategoryRejection — rejection happens ONLY when prev was a SUGGESTION", () => {
  test("clear over a SUGGESTED category → rejection of prev", async () => {
    await recordCategoryRejection(
      fakeUser(),
      "tx-1",
      { category_id: null },
      prev({ category_id: "cat-A", category_confidence: 0.7 }),
    );
    const insert = findInsertRejection();
    expect(insert).toBeDefined();
    expect(insert![1]).toEqual(["tx-1", "u-1", "cat-A"]);
    // No removeRejectedCategory because new is null
    expect(findDeleteRejection()).toBeUndefined();
  });

  test("clear over a CONFIRMED category → NOT a rejection (user re-categorizing, not rejecting)", async () => {
    await recordCategoryRejection(
      fakeUser(),
      "tx-1",
      { category_id: null },
      prev({ category_id: "cat-A", category_confidence: 1 }),
    );
    expect(findInsertRejection()).toBeUndefined();
    expect(findDeleteRejection()).toBeUndefined();
  });

  test("pick DIFFERENT over a SUGGESTED category → rejection of prev + cleanup of new", async () => {
    await recordCategoryRejection(
      fakeUser(),
      "tx-1",
      { category_id: "cat-B" },
      prev({ category_id: "cat-A", category_confidence: 0.7 }),
    );
    const insert = findInsertRejection();
    expect(insert).toBeDefined();
    expect(insert![1]).toEqual(["tx-1", "u-1", "cat-A"]);
    const del = findDeleteRejection();
    expect(del).toBeDefined();
    expect(del![1]).toEqual(["u-1", "tx-1", "cat-B"]);
  });

  test("pick DIFFERENT over a CONFIRMED category → NO rejection (re-categorize); still removes new", async () => {
    await recordCategoryRejection(
      fakeUser(),
      "tx-1",
      { category_id: "cat-B" },
      prev({ category_id: "cat-A", category_confidence: 1 }),
    );
    expect(findInsertRejection()).toBeUndefined();
    const del = findDeleteRejection();
    expect(del).toBeDefined();
    expect(del![1]).toEqual(["u-1", "tx-1", "cat-B"]);
  });

  test("budget switch (any) does not affect the suggested-only rule", async () => {
    // Budget switch is no longer a special case — same suggested-only
    // rule applies. Switching budget over a CONFIRMED clear is not a
    // rejection (re-categorize); switching budget over a SUGGESTED clear
    // IS a rejection (suggestion dropped).
    await recordCategoryRejection(
      fakeUser(),
      "tx-1",
      { budget_id: "budget-B", category_id: null },
      prev({ category_id: "cat-A", budget_id: "budget-A", category_confidence: 1 }),
    );
    expect(findInsertRejection()).toBeUndefined();

    clearSqlMocks();
    await recordCategoryRejection(
      fakeUser(),
      "tx-2",
      { budget_id: "budget-B", category_id: null },
      prev({ category_id: "cat-X", budget_id: "budget-A", category_confidence: 0.7 }),
    );
    const insert = findInsertRejection();
    expect(insert).toBeDefined();
    expect(insert![1]).toEqual(["tx-2", "u-1", "cat-X"]);
  });

  test("pick the SAME category as prev → no rejection added; removeRejectedCategory still fires", async () => {
    await recordCategoryRejection(
      fakeUser(),
      "tx-1",
      { category_id: "cat-A" },
      prev({ category_id: "cat-A", category_confidence: 0.7 }),
    );
    expect(findInsertRejection()).toBeUndefined();
    const del = findDeleteRejection();
    expect(del).toBeDefined();
    expect(del![1]).toEqual(["u-1", "tx-1", "cat-A"]);
  });

  test("no rejection if prev category was null — nothing to reject", async () => {
    await recordCategoryRejection(
      fakeUser(),
      "tx-1",
      { category_id: null },
      prev({ category_id: null }),
    );
    expect(findInsertRejection()).toBeUndefined();
  });

  test("pick a previously-rejected category back → DELETE the prior rejection (changed-my-mind)", async () => {
    await recordCategoryRejection(
      fakeUser(),
      "tx-1",
      { category_id: "cat-A" },
      prev({ category_id: null, category_confidence: null }),
    );
    const del = findDeleteRejection();
    expect(del).toBeDefined();
    expect(del![1]).toEqual(["u-1", "tx-1", "cat-A"]);
  });
});

describe("recordCategoryRejection — multi-user safety", () => {
  test("rejection write scopes ON CONFLICT path with user_id guard", async () => {
    await recordCategoryRejection(
      fakeUser(),
      "tx-1",
      { category_id: null },
      prev({ category_id: "cat-A", category_confidence: 0.7 }),
    );
    const insert = findInsertRejection();
    expect(insert).toBeDefined();
    expect(insert![0]).toMatch(/rejected_categories\.user_id\s*=\s*\$2/);
  });
});
