/**
 * Tests for the POST /api/suggest-category route.
 *
 * NOTE on mocking: we deliberately avoid `mock.module("server", ...)` here.
 * That mock is process-wide in Bun and leaks into sibling test files (e.g.
 * the transactions repo tests) which import their own barrel pieces. Instead
 * we monkey-patch the small surface we actually exercise on the real
 * imports, and restore originals in afterAll.
 */

import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";

import { pool, transactionsTable } from "server";
import { postSuggestCategoryRoute } from "./post-suggest-category";

const originalPoolQuery = pool.query.bind(pool);
const originalTxUpdate = transactionsTable.update.bind(transactionsTable);

const mockPoolQuery = mock(
  (_sql: string, _values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }> =>
    Promise.resolve({ rows: [], rowCount: 0 }),
);
const mockTxUpdate = mock(
  async (
    _id: unknown,
    _data: unknown,
    _returning?: string[],
    _userId?: string,
  ): Promise<Record<string, unknown> | null> => null,
);

(pool as unknown as { query: typeof mockPoolQuery }).query = mockPoolQuery;
(transactionsTable as unknown as { update: typeof mockTxUpdate }).update = mockTxUpdate;

afterAll(() => {
  // Restore real bindings so other test files (run later in the same
  // process) see un-mocked behavior.
  (pool as unknown as { query: typeof originalPoolQuery }).query = originalPoolQuery;
  (transactionsTable as unknown as { update: typeof originalTxUpdate }).update =
    originalTxUpdate;
});

beforeEach(() => {
  mockPoolQuery.mockReset();
  mockTxUpdate.mockReset();
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
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ category_id: "c-1" }], rowCount: 1 });

    const result = await postSuggestCategoryRoute.execute(
      makeReq({
        suggestions: [
          { transaction_id: "t-1", confidence: 0.99, label_category_id: "c-1" },
        ],
      }),
      fakeRes(),
    );
    expect(result?.body?.skipped).toBe(1);
    expect(result?.body?.outcomes[0].status).toBe("skipped");
  });

  test("refuses to overwrite a confidence=1.0 row", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ transaction_id: "t-1", label_category_confidence: 1 }],
      rowCount: 1,
    });
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ category_id: "c-1" }], rowCount: 1 });

    const result = await postSuggestCategoryRoute.execute(
      makeReq({
        suggestions: [
          { transaction_id: "t-1", confidence: 0.99, label_category_id: "c-1" },
        ],
      }),
      fakeRes(),
    );
    expect(result?.body?.skipped).toBe(1);
    const o = result?.body?.outcomes[0] as { status: string; reason?: string };
    expect(o.status).toBe("skipped");
    expect(o.reason).toContain("user-confirmed");
  });

  test("rejects unknown category for the user", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ transaction_id: "t-1", label_category_confidence: null }],
      rowCount: 1,
    });
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await postSuggestCategoryRoute.execute(
      makeReq({
        suggestions: [
          { transaction_id: "t-1", confidence: 0.99, label_category_id: "c-x" },
        ],
      }),
      fakeRes(),
    );
    expect(result?.body?.errored).toBe(1);
  });

  test("updates a valid suggestion and writes the confidence", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ transaction_id: "t-1", label_category_confidence: 0.5 }],
      rowCount: 1,
    });
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ category_id: "c-1" }], rowCount: 1 });
    mockTxUpdate.mockResolvedValueOnce({ transaction_id: "t-1" });

    const result = await postSuggestCategoryRoute.execute(
      makeReq({
        suggestions: [
          {
            transaction_id: "t-1",
            confidence: 0.99,
            label_category_id: "c-1",
          },
        ],
      }),
      fakeRes(),
    );
    expect(result?.body?.updated).toBe(1);

    const [id, updates, , userId] = mockTxUpdate.mock.calls[0];
    expect(id).toBe("t-1");
    expect((updates as Record<string, unknown>).label_category_confidence).toBe(0.99);
    expect((updates as Record<string, unknown>).label_category_id).toBe("c-1");
    expect(userId).toBe("u-1");
  });

  test("requires at least one of category_id / budget_id", async () => {
    mockPoolQuery.mockResolvedValueOnce({
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
