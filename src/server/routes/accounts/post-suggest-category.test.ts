// Per-test-bundle isolation — see scripts/test-bundled/.
// @bundles src/server/routes/accounts/post-suggest-category.ts
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { bundleOf } from "test-bundled";

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

const { postSuggestCategoryRoute } = await bundleOf<typeof import("./post\-suggest\-category")>(import.meta.url);

beforeEach(() => {
  mockQuery.mockReset();
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
 * Find the parameterized UPDATE call in mockQuery's call log. The route
 * issues several SELECTs first (ownership check, category check); the
 * UPDATE on `transactions` is the call that actually applies the
 * suggestion. Returns `null` if no UPDATE was issued.
 */
const findUpdateCall = (): { sql: string; values: unknown[] } | null => {
  for (const call of mockQuery.mock.calls) {
    const sql = call[0] as string;
    if (/UPDATE\s+transactions/i.test(sql)) return { sql, values: call[1] as unknown[] };
  }
  return null;
};

describe("post-suggest-category", () => {
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
        suggestions: [{ transaction_id: "t-1", confidence: 1.0, label_category_id: "c-1" }],
      }),
      fakeRes(),
    );
    expect(result?.body?.errored).toBe(1);
  });

  test("rejects confidence at the boundary 0", async () => {
    const result = await postSuggestCategoryRoute.execute(
      makeReq({
        suggestions: [{ transaction_id: "t-1", confidence: 0, label_category_id: "c-1" }],
      }),
      fakeRes(),
    );
    expect(result?.body?.errored).toBe(1);
  });

  test("skips transactions not owned by the user", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockQuery.mockResolvedValueOnce({ rows: [{ category_id: "c-1" }], rowCount: 1 });

    const result = await postSuggestCategoryRoute.execute(
      makeReq({
        suggestions: [{ transaction_id: "t-1", confidence: 0.99, label_category_id: "c-1" }],
      }),
      fakeRes(),
    );
    expect(result?.body?.skipped).toBe(1);
    expect(result?.body?.outcomes[0].status).toBe("skipped");
  });

  test("refuses to overwrite a confidence=1.0 row", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ transaction_id: "t-1", label_category_confidence: 1 }],
      rowCount: 1,
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ category_id: "c-1" }], rowCount: 1 });

    const result = await postSuggestCategoryRoute.execute(
      makeReq({
        suggestions: [{ transaction_id: "t-1", confidence: 0.99, label_category_id: "c-1" }],
      }),
      fakeRes(),
    );
    expect(result?.body?.skipped).toBe(1);
    const o = result?.body?.outcomes[0] as { status: string; reason?: string };
    expect(o.status).toBe("skipped");
    expect(o.reason).toContain("user-confirmed");
  });

  test("rejects unknown category for the user", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ transaction_id: "t-1", label_category_confidence: null }],
      rowCount: 1,
    });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await postSuggestCategoryRoute.execute(
      makeReq({
        suggestions: [{ transaction_id: "t-1", confidence: 0.99, label_category_id: "c-x" }],
      }),
      fakeRes(),
    );
    expect(result?.body?.errored).toBe(1);
  });

  test("updates a valid suggestion and writes the confidence", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ transaction_id: "t-1", label_category_confidence: 0.5 }],
      rowCount: 1,
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ category_id: "c-1" }], rowCount: 1 });
    // The UPDATE call returns the updated row; the post-update SELECT (if
    // any) returns whatever the route reads back.
    mockQuery.mockResolvedValueOnce({ rows: [{ transaction_id: "t-1" }], rowCount: 1 });

    const result = await postSuggestCategoryRoute.execute(
      makeReq({
        suggestions: [
          { transaction_id: "t-1", confidence: 0.99, label_category_id: "c-1" },
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
    expect(upd!.values).toContain("c-1");
    expect(upd!.values).toContain("t-1");
    expect(upd!.values).toContain("u-1");
  });

  test("requires at least one of category_id / budget_id", async () => {
    mockQuery.mockResolvedValueOnce({
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
      label_category_id: "c-1",
    }));
    const result = await postSuggestCategoryRoute.execute(
      makeReq({ suggestions: huge }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
  });
});
