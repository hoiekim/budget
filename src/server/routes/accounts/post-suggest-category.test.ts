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

describe("post-suggest-category", () => {
  // category_id / budget_id are UUID PRIMARY KEY columns: fixtures must be
  // well-formed UUIDs, or the pre-fetch filter drops them before the query
  // and the "valid suggestion" tests below would fail at the Unknown-id
  // branch instead of reaching the UPDATE (#789).
  const GOOD_CATEGORY_ID = "11111111-1111-4111-8111-111111111111";
  const UNKNOWN_CATEGORY_ID = "22222222-2222-4222-8222-222222222222";

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
    mockUnsafe.mockResolvedValueOnce({ rows: [{ category_id: GOOD_CATEGORY_ID }], rowCount: 1 });

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
      rows: [{ transaction_id: "t-1", label_category_confidence: 1 }],
      rowCount: 1,
    });
    mockUnsafe.mockResolvedValueOnce({ rows: [{ category_id: GOOD_CATEGORY_ID }], rowCount: 1 });

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
      rows: [{ transaction_id: "t-1", label_category_confidence: null }],
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

  test("updates a valid suggestion and writes the confidence", async () => {
    mockUnsafe.mockResolvedValueOnce({
      rows: [{ transaction_id: "t-1", label_category_confidence: 0.5 }],
      rowCount: 1,
    });
    mockUnsafe.mockResolvedValueOnce({ rows: [{ category_id: GOOD_CATEGORY_ID }], rowCount: 1 });
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
      rows: [{ transaction_id: "t-1", label_category_confidence: null }],
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
        { transaction_id: "t-1", label_category_confidence: 0.5 },
        { transaction_id: "t-2", label_category_confidence: 0.5 },
      ],
      rowCount: 2,
    });
    mockUnsafe.mockResolvedValueOnce({
      rows: [{ category_id: GOOD_CATEGORY_ID }],
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
});
