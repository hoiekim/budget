// `recordSuggestionFeedback` decides which suggestion-log write a transaction
// label update implies: a user confirmation (confidence 1), a user rejection
// (confidence 0, not a budget switch), or nothing. The two upsert helpers it
// calls run real SQL through `pool.query`, so the leaf mocks `pg` and the test
// asserts on the captured INSERT — confirm vs reject is distinguished by the
// `confirmed_at` column, which only the confirmed upsert writes.
import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";

// A fully-shaped row so the upserts' `new SuggestionModel(...)` type check
// passes; the helper ignores the return value, so the contents are arbitrary.
const okRow = {
  transaction_id: "tx",
  user_id: "u-1",
  category_id: "cat",
  confidence: 1,
  is_confirmed: true,
  is_rejected: false,
  confirmed_at: null,
  engine_scored_at: null,
  updated: null,
};

const mockQuery = mock(async (_sql: string, _values?: unknown[]) => ({
  rows: [okRow] as unknown[],
  rowCount: 1 as number | null,
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

const { recordSuggestionFeedback } = await import("./record-suggestion-feedback");

afterAll(restoreLeaves);

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockImplementation(async () => ({ rows: [okRow], rowCount: 1 }));
});

const user = { user_id: "u-1", username: "alice" } as unknown as Parameters<
  typeof recordSuggestionFeedback
>[0];

// Pull the suggestion INSERT out of the captured pool queries.
const writes = () =>
  mockQuery.mock.calls.filter((c) => /INSERT INTO suggestions/i.test(c[0] as string));

const isConfirm = (sql: string) => /confirmed_at/i.test(sql);

describe("recordSuggestionFeedback", () => {
  test("explicit category pick (confidence 1) → confirms the picked category", async () => {
    await recordSuggestionFeedback(
      user,
      "tx-1",
      { category_id: "cat-1", category_confidence: 1 },
      { category_id: null, budget_id: "bud-1" },
    );
    const w = writes();
    expect(w).toHaveLength(1);
    expect(isConfirm(w[0][0] as string)).toBe(true);
    // values: [transaction_id, user_id, category_id]
    expect(w[0][1]).toEqual(["tx-1", "u-1", "cat-1"]);
  });

  test("accept-in-place (confidence 1, no body category) → confirms the row's current category", async () => {
    await recordSuggestionFeedback(
      user,
      "tx-2",
      { category_confidence: 1 },
      { category_id: "cat-9", budget_id: "bud-1" },
    );
    const w = writes();
    expect(w).toHaveLength(1);
    expect(isConfirm(w[0][0] as string)).toBe(true);
    expect(w[0][1]).toEqual(["tx-2", "u-1", "cat-9"]);
  });

  test("clear category (confidence 0) → rejects the row's previous category", async () => {
    await recordSuggestionFeedback(
      user,
      "tx-3",
      { category_id: null, category_confidence: 0 },
      { category_id: "cat-2", budget_id: "bud-1" },
    );
    const w = writes();
    expect(w).toHaveLength(1);
    expect(isConfirm(w[0][0] as string)).toBe(false);
    expect(w[0][1]).toEqual(["tx-3", "u-1", "cat-2"]);
  });

  test("clear with no previous category → nothing to reject, no write", async () => {
    await recordSuggestionFeedback(
      user,
      "tx-4",
      { category_id: null, category_confidence: 0 },
      { category_id: null, budget_id: "bud-1" },
    );
    expect(writes()).toHaveLength(0);
  });

  test("budget switch that clears the category (confidence 0, budget changed) → not a rejection", async () => {
    await recordSuggestionFeedback(
      user,
      "tx-5",
      { budget_id: "bud-2", category_id: null, category_confidence: 0 },
      { category_id: "cat-3", budget_id: "bud-1" },
    );
    expect(writes()).toHaveLength(0);
  });

  test("category clear that leaves the budget unchanged → still a rejection", async () => {
    await recordSuggestionFeedback(
      user,
      "tx-6",
      { budget_id: "bud-1", category_id: null, category_confidence: 0 },
      { category_id: "cat-4", budget_id: "bud-1" },
    );
    const w = writes();
    expect(w).toHaveLength(1);
    expect(isConfirm(w[0][0] as string)).toBe(false);
    expect(w[0][1]).toEqual(["tx-6", "u-1", "cat-4"]);
  });

  test("engine-fractional confidence → no user-action write", async () => {
    await recordSuggestionFeedback(
      user,
      "tx-7",
      { category_id: "cat-5", category_confidence: 0.97 },
      { category_id: null, budget_id: "bud-1" },
    );
    expect(writes()).toHaveLength(0);
  });

  test("label without category_confidence → no-op", async () => {
    await recordSuggestionFeedback(
      user,
      "tx-8",
      { budget_id: "bud-2" },
      { category_id: "cat-6", budget_id: "bud-1" },
    );
    expect(writes()).toHaveLength(0);
  });

  test("undefined label → no-op", async () => {
    await recordSuggestionFeedback(user, "tx-9", undefined, {
      category_id: "cat-7",
      budget_id: "bud-1",
    });
    expect(writes()).toHaveLength(0);
  });
});
