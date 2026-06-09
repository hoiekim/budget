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
  mockQuery.mockReset();
  mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
});

const findInsertRejection = () =>
  mockQuery.mock.calls.find((c) => /INSERT INTO rejected_categories/i.test(c[0]));
const findDeleteRejection = () =>
  mockQuery.mock.calls.find((c) => /DELETE FROM rejected_categories/i.test(c[0]));

describe("recordCategoryRejection — body shape gating", () => {
  test("no category change in request → no DB call", async () => {
    await recordCategoryRejection(
      fakeUser(),
      "tx-1",
      { memo: "groceries" },
      prev({ category_id: "cat-A", category_confidence: 1 }),
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("undefined reqLabel → no DB call", async () => {
    await recordCategoryRejection(
      fakeUser(),
      "tx-1",
      undefined,
      prev({ category_id: "cat-A", category_confidence: 1 }),
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("recordCategoryRejection — clearing the category", () => {
  test("budget switch on a CONFIRMED label is a FE side-effect — NOT a rejection", async () => {
    await recordCategoryRejection(
      fakeUser(),
      "tx-1",
      { budget_id: "budget-B", category_id: null },
      prev({ category_id: "cat-A", budget_id: "budget-A", category_confidence: 1 }),
    );
    expect(findInsertRejection()).toBeUndefined();
    expect(findDeleteRejection()).toBeUndefined();
  });

  test("budget switch on a SUGGESTED label IS a rejection (Hoie 2026-06-09)", async () => {
    await recordCategoryRejection(
      fakeUser(),
      "tx-1",
      { budget_id: "budget-B", category_id: null },
      prev({ category_id: "cat-A", budget_id: "budget-A", category_confidence: 0.7 }),
    );
    const insert = findInsertRejection();
    expect(insert).toBeDefined();
    expect(insert![1]).toEqual(["tx-1", "u-1", "cat-A"]);
  });

  test("clear without budget change AND prev was confirmed → rejection", async () => {
    await recordCategoryRejection(
      fakeUser(),
      "tx-1",
      { category_id: null },
      prev({ category_id: "cat-A", budget_id: "budget-A", category_confidence: 1 }),
    );
    const insert = findInsertRejection();
    expect(insert).toBeDefined();
    expect(insert![1]).toEqual(["tx-1", "u-1", "cat-A"]);
  });

  test("clear with body re-stating UNCHANGED budget_id → still a rejection (budget didn't actually change)", async () => {
    await recordCategoryRejection(
      fakeUser(),
      "tx-1",
      { budget_id: "budget-A", category_id: null },
      prev({ category_id: "cat-A", budget_id: "budget-A", category_confidence: 1 }),
    );
    const insert = findInsertRejection();
    expect(insert).toBeDefined();
    expect(insert![1]).toEqual(["tx-1", "u-1", "cat-A"]);
  });

  test("no rejection if prev category was null — nothing concrete to record", async () => {
    await recordCategoryRejection(
      fakeUser(),
      "tx-1",
      { category_id: null },
      prev({ category_id: null }),
    );
    expect(findInsertRejection()).toBeUndefined();
  });
});

describe("recordCategoryRejection — picking a category", () => {
  test("picking the SAME category as prev → only DELETE any prior rejection of that category", async () => {
    await recordCategoryRejection(
      fakeUser(),
      "tx-1",
      { category_id: "cat-A" },
      prev({ category_id: "cat-A", category_confidence: 1 }),
    );
    expect(findInsertRejection()).toBeUndefined();
    const del = findDeleteRejection();
    expect(del).toBeDefined();
    expect(del![1]).toEqual(["u-1", "tx-1", "cat-A"]);
  });

  test("picking DIFFERENT category over a SUGGESTED one → rejection of the suggested + cleanup of new (Hoie 2026-06-09)", async () => {
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

  test("picking DIFFERENT category over a CONFIRMED one → NO rejection of the old confirmed (user is re-categorizing, not rejecting)", async () => {
    // A user replacing a previously-confirmed label with a different
    // category is choosing a different correct answer — not rejecting
    // their prior choice as wrong. Confirmation history isn't rewritten.
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

  test("picking a previously-rejected category back → DELETE the prior rejection (changed-my-mind)", async () => {
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
      prev({ category_id: "cat-A", category_confidence: 1 }),
    );
    const insert = findInsertRejection();
    expect(insert).toBeDefined();
    expect(insert![0]).toMatch(/rejected_categories\.user_id\s*=\s*\$2/);
  });
});
