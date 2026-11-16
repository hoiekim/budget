import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";

const { driver, mockUnsafe, resetSqlMocks } = createFakeSql();

mock.module("../../lib/postgres/sql-driver", () => driver);

const { postSuggestCategoryRoute } = await import("./post\-suggest\-category");

afterAll(restoreLeaves);

beforeEach(() => {
  resetSqlMocks();
});

function makeReq(body: unknown, userId = "u-1") {
  return {
    method: "POST",
    path: "/suggest-category",
    url: "http://x/api/suggest-category",
    headers: {},
    query: {},
    body,
    session: {
      id: "s-1",
      user: { user_id: userId, username: "test" },
      regenerate() {},
      destroy() {},
    },
    ip: "127.0.0.1",
  } as unknown as Parameters<typeof postSuggestCategoryRoute.execute>[0];
}

const fakeRes = () =>
  ({
    statusCode: 200,
    headersSent: false,
    status() {
      return this;
    },
    write() {
      return true;
    },
    end() {},
  }) as unknown as Parameters<typeof postSuggestCategoryRoute.execute>[1];

/**
 * Find the parameterized UPDATE call in mockUnsafe's call log. The route
 * issues several SELECTs first (ownership check, category check); the
 * UPDATE on `transactions` is the call that actually applies the
 * suggestion. Returns `null` if no UPDATE was issued.
 */
const findUpdateCall = (): { sql: string; values: unknown[] } | null => {
  for (const call of mockUnsafe.mock.calls) {
    const sql = call[0] as string;
    if (/UPDATE\s+transactions/i.test(sql)) return { sql, values: call[1] as unknown[] };
  }
  return null;
};

const countCalls = (pattern: RegExp): number =>
  mockUnsafe.mock.calls.filter((call) => pattern.test(call[0] as string)).length;

const findSelectCall = (table: string): { sql: string; values: unknown[] } | null => {
  const call = mockUnsafe.mock.calls.find((c) =>
    new RegExp(`FROM ${table}`, "i").test(c[0] as string),
  );
  return call ? { sql: call[0] as string, values: call[1] as unknown[] } : null;
};

// The route reads through `queryByIds`, which constructs model instances
// from the returned rows — mocked rows must satisfy the models' full
// type-checkers (required string fields plus explicit nulls), not just the
// columns the route reads.
const txRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  transaction_id: "t-1",
  user_id: "u-1",
  account_id: "a-1",
  name: null,
  merchant_name: null,
  amount: null,
  iso_currency_code: null,
  date: "2026-01-01",
  pending: null,
  pending_transaction_id: null,
  payment_channel: null,
  location_country: null,
  location_region: null,
  location_city: null,
  label_budget_id: null,
  label_category_id: null,
  label_memo: null,
  label_category_confidence: null,
  raw: null,
  updated: null,
  is_deleted: null,
  source: null,
  ...overrides,
});

const categoryRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  category_id: "11111111-1111-4111-8111-111111111111",
  user_id: "u-1",
  section_id: "s-1",
  name: null,
  roll_over: null,
  roll_over_start_date: null,
  capacities: null,
  updated: null,
  is_deleted: null,
  ...overrides,
});

const budgetRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  budget_id: "33333333-3333-4333-8333-333333333333",
  user_id: "u-1",
  name: null,
  iso_currency_code: null,
  roll_over: null,
  roll_over_start_date: null,
  capacities: null,
  updated: null,
  is_deleted: null,
  ...overrides,
});

describe("post-suggest-category", () => {
  // category_id / budget_id are UUID PRIMARY KEY columns: fixtures must be
  // well-formed UUIDs, or the pre-fetch filter drops them before the query
  // and the "valid suggestion" tests below would fail at the Unknown-id
  // branch instead of reaching the UPDATE (#789).
  const GOOD_CATEGORY_ID = "11111111-1111-4111-8111-111111111111";
  const UNKNOWN_CATEGORY_ID = "22222222-2222-4222-8222-222222222222";
  const GOOD_BUDGET_ID = "33333333-3333-4333-8333-333333333333";
  const UNKNOWN_BUDGET_ID = "44444444-4444-4444-8444-444444444444";

  test("declares requiredScope = transactions:suggest", () => {
    expect(postSuggestCategoryRoute.requiredScope).toBe("transactions:suggest");
  });

  test("rejects unauthenticated requests", async () => {
    const req = makeReq({ suggestions: [] });
    (req.session as { user?: unknown }).user = undefined;
    const result = await postSuggestCategoryRoute.execute(req, fakeRes());
    expect(result?.status).toBe("failed");
  });

  test("requires a suggestions array", async () => {
    const result = await postSuggestCategoryRoute.execute(makeReq({}), fakeRes());
    expect(result?.status).toBe("failed");
  });

  test("returns empty summary for empty array", async () => {
    const result = await postSuggestCategoryRoute.execute(
      makeReq({ suggestions: [] }),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    expect(result?.body).toEqual({ outcomes: [], updated: 0, skipped: 0, errored: 0 });
  });

  test("rejects malformed entries (missing transaction_id)", async () => {
    const result = await postSuggestCategoryRoute.execute(
      makeReq({ suggestions: [{ confidence: 0.99 }] }),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    const r = result?.body!;
    expect(r.errored).toBe(1);
    expect(r.outcomes[0].status).toBe("error");
  });

  test("rejects confidence at the boundary 1.0", async () => {
    const result = await postSuggestCategoryRoute.execute(
      makeReq({
        suggestions: [{ transaction_id: "t-1", confidence: 1.0, label_category_id: GOOD_CATEGORY_ID }],
      }),
      fakeRes(),
    );
    expect(result?.body?.errored).toBe(1);
  });

  test("rejects confidence at the boundary 0", async () => {
    const result = await postSuggestCategoryRoute.execute(
      makeReq({
        suggestions: [{ transaction_id: "t-1", confidence: 0, label_category_id: GOOD_CATEGORY_ID }],
      }),
      fakeRes(),
    );
    expect(result?.body?.errored).toBe(1);
  });

  test("skips transactions not owned by the user", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockUnsafe.mockResolvedValueOnce({ rows: [categoryRow()], rowCount: 1 });

    const result = await postSuggestCategoryRoute.execute(
      makeReq({
        suggestions: [{ transaction_id: "t-1", confidence: 0.99, label_category_id: GOOD_CATEGORY_ID }],
      }),
      fakeRes(),
    );
    expect(result?.body?.skipped).toBe(1);
    expect(result?.body?.outcomes[0].status).toBe("skipped");
  });

  test("refuses to overwrite a confidence=1.0 row", async () => {
    mockUnsafe.mockResolvedValueOnce({
      rows: [txRow({ label_category_confidence: 1 })],
      rowCount: 1,
    });
    mockUnsafe.mockResolvedValueOnce({ rows: [categoryRow()], rowCount: 1 });

    const result = await postSuggestCategoryRoute.execute(
      makeReq({
        suggestions: [{ transaction_id: "t-1", confidence: 0.99, label_category_id: GOOD_CATEGORY_ID }],
      }),
      fakeRes(),
    );
    expect(result?.body?.skipped).toBe(1);
    const o = result?.body?.outcomes[0] as { status: string; reason?: string };
    expect(o.status).toBe("skipped");
    expect(o.reason).toContain("user-confirmed");
  });

  test("rejects unknown category for the user", async () => {
    mockUnsafe.mockResolvedValueOnce({
      rows: [txRow({ label_category_confidence: null })],
      rowCount: 1,
    });
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await postSuggestCategoryRoute.execute(
      makeReq({
        suggestions: [{ transaction_id: "t-1", confidence: 0.99, label_category_id: UNKNOWN_CATEGORY_ID }],
      }),
      fakeRes(),
    );
    expect(result?.body?.errored).toBe(1);
  });

  test("rejects unknown budget for the user", async () => {
    mockUnsafe.mockResolvedValueOnce({
      rows: [txRow({ label_category_confidence: null })],
      rowCount: 1,
    });
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await postSuggestCategoryRoute.execute(
      makeReq({
        suggestions: [{ transaction_id: "t-1", confidence: 0.99, label_budget_id: UNKNOWN_BUDGET_ID }],
      }),
      fakeRes(),
    );
    expect(result?.body?.errored).toBe(1);
    expect(result?.body?.outcomes[0].status).toBe("error");
    expect((result?.body?.outcomes[0] as { reason?: string }).reason).toContain(
      `Unknown label_budget_id: ${UNKNOWN_BUDGET_ID}`,
    );
    // The budget branch must be probed separately from the category
    // branch: a regression that drops the budget pre-fetch stays green
    // on the category test alone.
    expect(findUpdateCall()).toBeNull();
  });

  test("updates a valid suggestion and writes the confidence", async () => {
    mockUnsafe.mockResolvedValueOnce({
      rows: [txRow({ label_category_confidence: 0.5 })],
      rowCount: 1,
    });
    mockUnsafe.mockResolvedValueOnce({ rows: [categoryRow()], rowCount: 1 });
    // The UPDATE call returns the updated row; the post-update SELECT (if
    // any) returns whatever the route reads back.
    mockUnsafe.mockResolvedValueOnce({ rows: [{ transaction_id: "t-1" }], rowCount: 1 });

    const result = await postSuggestCategoryRoute.execute(
      makeReq({
        suggestions: [
          { transaction_id: "t-1", confidence: 0.99, label_category_id: GOOD_CATEGORY_ID },
        ],
      }),
      fakeRes(),
    );
    expect(result?.body?.updated).toBe(1);

    // Verify the UPDATE statement carries the new confidence + category_id
    // + the caller's user_id. Pinning at the SQL-param layer instead of the
    // model-method args.
    const upd = findUpdateCall();
    expect(upd).not.toBeNull();
    expect(upd!.values).toContain(0.99);
    expect(upd!.values).toContain(GOOD_CATEGORY_ID);
    expect(upd!.values).toContain("t-1");
    expect(upd!.values).toContain("u-1");
  });

  test("requires at least one of category_id / budget_id", async () => {
    mockUnsafe.mockResolvedValueOnce({
      rows: [txRow()],
      rowCount: 1,
    });

    const result = await postSuggestCategoryRoute.execute(
      makeReq({ suggestions: [{ transaction_id: "t-1", confidence: 0.99 }] }),
      fakeRes(),
    );
    expect(result?.body?.errored).toBe(1);
  });

  test("caps batch at 500 entries", async () => {
    const huge = Array.from({ length: 501 }, (_, i) => ({
      transaction_id: `t-${i}`,
      confidence: 0.99,
      label_category_id: GOOD_CATEGORY_ID,
    }));
    const result = await postSuggestCategoryRoute.execute(
      makeReq({ suggestions: huge }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
  });

  test("a malformed label_category_id errors only its own row (#789)", async () => {
    // Regression: before the fix, "nope" was bound against the UUID
    // category_id column, Postgres raised 22P02, and the whole batch 500d
    // — the well-formed row was discarded with it. Now the malformed id
    // never reaches the pre-fetch and lands on the per-row Unknown-id
    // branch instead.
    mockUnsafe.mockResolvedValueOnce({
      rows: [
        txRow({ label_category_confidence: 0.5 }),
        txRow({ transaction_id: "t-2", label_category_confidence: 0.5 }),
      ],
      rowCount: 2,
    });
    mockUnsafe.mockResolvedValueOnce({
      rows: [categoryRow()],
      rowCount: 1,
    });
    // The UPDATE call returns the updated row.
    mockUnsafe.mockResolvedValueOnce({ rows: [{ transaction_id: "t-1" }], rowCount: 1 });

    const result = await postSuggestCategoryRoute.execute(
      makeReq({
        suggestions: [
          { transaction_id: "t-1", confidence: 0.99, label_category_id: GOOD_CATEGORY_ID },
          { transaction_id: "t-2", confidence: 0.99, label_category_id: "nope" },
        ],
      }),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    expect(result?.body?.updated).toBe(1);
    expect(result?.body?.errored).toBe(1);
    const bad = result?.body?.outcomes.find((o) => o.transaction_id === "t-2");
    expect(bad?.status).toBe("error");
    expect((bad as { reason?: string }).reason).toContain(
      "Unknown label_category_id: nope",
    );
    // The malformed id was never bound against the UUID column.
    const categoryCall = mockUnsafe.mock.calls.find((call) =>
      /FROM categories/i.test(call[0] as string),
    );
    expect(categoryCall).toBeDefined();
    expect(categoryCall![1] as unknown[]).not.toContain("nope");
    const upd = findUpdateCall();
    expect(upd).not.toBeNull();
    expect(upd!.values).toContain(GOOD_CATEGORY_ID);
    expect(upd!.values).not.toContain("nope");
  });

  test("applies a mixed batch with one pre-fetch per table and keeps input order", async () => {
    mockUnsafe.mockResolvedValueOnce({
      rows: [
        txRow({ label_category_confidence: 0.5 }),
        txRow({ transaction_id: "t-2", label_category_confidence: 0.5 }),
        txRow({ transaction_id: "t-3", label_category_confidence: 1 }),
      ],
      rowCount: 3,
    });
    mockUnsafe.mockResolvedValueOnce({ rows: [categoryRow()], rowCount: 1 });
    mockUnsafe.mockResolvedValueOnce({ rows: [budgetRow()], rowCount: 1 });
    mockUnsafe.mockResolvedValueOnce({ rows: [{ transaction_id: "t-1" }], rowCount: 1 });
    mockUnsafe.mockResolvedValueOnce({ rows: [{ transaction_id: "t-2" }], rowCount: 1 });

    const result = await postSuggestCategoryRoute.execute(
      makeReq({
        suggestions: [
          { transaction_id: "t-1", confidence: 0.99, label_category_id: GOOD_CATEGORY_ID },
          { transaction_id: "t-2", confidence: 0.99, label_budget_id: GOOD_BUDGET_ID },
          { transaction_id: "t-3", confidence: 0.99, label_category_id: GOOD_CATEGORY_ID },
        ],
      }),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    expect(result?.body?.updated).toBe(2);
    expect(result?.body?.skipped).toBe(1);
    expect(result?.body?.outcomes.map((o) => o.status)).toEqual([
      "updated",
      "updated",
      "skipped",
    ]);
    // One batched read per table for the whole request, not one per row.
    expect(countCalls(/SELECT \* FROM transactions/i)).toBe(1);
    expect(countCalls(/SELECT \* FROM categories/i)).toBe(1);
    expect(countCalls(/SELECT \* FROM budgets/i)).toBe(1);
    const txSelect = findSelectCall("transactions");
    expect(txSelect!.values).toEqual(
      expect.arrayContaining(["t-1", "t-2", "t-3", "u-1"]),
    );
    // One UPDATE per applied suggestion, no UPDATE for the skipped row.
    expect(countCalls(/UPDATE\s+transactions/i)).toBe(2);
  });

  test("applies a batch larger than one chunk", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `t-${i}`);
    mockUnsafe.mockResolvedValueOnce({
      rows: ids.map((id) => txRow({ transaction_id: id, label_category_confidence: 0.5 })),
      rowCount: 12,
    });
    mockUnsafe.mockResolvedValueOnce({ rows: [categoryRow()], rowCount: 1 });
    // After the three pre-fetch mocks are consumed, every UPDATE resolves
    // to an updated row.
    mockUnsafe.mockImplementation(async () => ({ rows: [{ transaction_id: "t-0" }], rowCount: 1 }));

    const result = await postSuggestCategoryRoute.execute(
      makeReq({
        suggestions: ids.map((id) => ({
          transaction_id: id,
          confidence: 0.99,
          label_category_id: GOOD_CATEGORY_ID,
        })),
      }),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    expect(result?.body?.updated).toBe(12);
    expect(countCalls(/UPDATE\s+transactions/i)).toBe(12);
  });
});
