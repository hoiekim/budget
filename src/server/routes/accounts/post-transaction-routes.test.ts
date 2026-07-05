import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";

// Route-level coverage for the FE→DB label-write trio
// (post-transaction / post-split-transaction / post-investment-transaction).
// The repo functions and `inferLabelConfidence` are unit-tested in isolation;
// what is uncovered is the *wiring* that ties them together — the route reads
// the body, runs the confidence inference, and hands the result to the repo.
// PR #431 added the inference to two of these routes precisely because a
// silent confidence drop went unobserved while the route layer had no test.
//
// We pin behavior at the SQL-param layer: a FakePool intercepts pg, the route
// is driven through `.execute`, and the UPDATE statement's bound values are
// asserted. This catches a regression in the route→repo handoff that a repo
// unit test (which writes exactly what it's told) cannot.
// A single flag drives the failure path. Re-`mockImplementation`-ing a Bun
// mock inside a test does not reliably replace the `beforeEach` default, so the
// default impl itself branches on this flag — flip it to simulate a DB error.
let failQueries = false;
const mockQuery = mock(async (_sql: string, _values?: unknown[]) => {
  if (failQueries) throw new Error("db down");
  return { rows: [] as unknown[], rowCount: 0 as number | null };
});

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

const { postTransactionRoute } = await import("./post-transaction");
const { postSplitTransactionRoute } = await import("./post-split-transaction");
const { postInvestmentTransactionRoute } = await import("./post-investment-transaction");

afterAll(restoreLeaves);

beforeEach(() => {
  // Clear the call log but keep the flag-driven implementation (mockReset would
  // wipe it, and re-setting an impl per test doesn't reliably stick in Bun).
  mockQuery.mockClear();
  failQueries = false;
});

type AnyRoute =
  | typeof postTransactionRoute
  | typeof postSplitTransactionRoute
  | typeof postInvestmentTransactionRoute;

function makeReq(route: AnyRoute, body: unknown, userId?: string) {
  return {
    method: "POST",
    path: "/x",
    url: "http://x/api/x",
    headers: {},
    query: {},
    body,
    session: {
      id: "s-1",
      user: userId ? { user_id: userId, username: "test" } : undefined,
      regenerate() {},
      destroy() {},
    },
    ip: "127.0.0.1",
  } as unknown as Parameters<typeof route.execute>[0];
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
  }) as unknown as Parameters<typeof postTransactionRoute.execute>[1];

/** Find the parameterized UPDATE against `table` in the mock call log. */
const findUpdate = (table: string): { sql: string; values: unknown[] } | null => {
  const re = new RegExp(`UPDATE\\s+${table}\\b`, "i");
  for (const call of mockQuery.mock.calls) {
    const sql = call[0] as string;
    if (re.test(sql)) return { sql, values: call[1] as unknown[] };
  }
  return null;
};

const SENTINEL = Symbol("column-absent");
/**
 * Pull the value bound to `column` in an UPDATE built by `buildUpdate`
 * (`SET col = $N, ...`). Returns SENTINEL when the column isn't in the SET
 * list — distinguishing "wrote null" from "didn't write the column at all".
 */
const boundValue = (upd: { sql: string; values: unknown[] }, column: string): unknown => {
  const m = upd.sql.match(new RegExp(`\\b${column}\\s*=\\s*\\$(\\d+)`));
  if (!m) return SENTINEL;
  return upd.values[Number(m[1]) - 1];
};

describe("post-transaction route", () => {
  test("rejects unauthenticated requests", async () => {
    const req = makeReq(postTransactionRoute, { transaction_id: "t-1" });
    const result = await postTransactionRoute.execute(req, fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("rejects a non-object body", async () => {
    const result = await postTransactionRoute.execute(
      makeReq(postTransactionRoute, "not-an-object", "u-1"),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("rejects a missing transaction_id", async () => {
    const result = await postTransactionRoute.execute(
      makeReq(postTransactionRoute, { label: { category_id: "c-1" } }, "u-1"),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/transaction_id/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("set-category with confidence omitted → infers category_confidence = 1, scoped to user", async () => {
    const result = await postTransactionRoute.execute(
      makeReq(postTransactionRoute, { transaction_id: "t-1", label: { category_id: "c-1" } }, "u-1"),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    expect(result?.body).toEqual({ transaction_id: "t-1" });

    const upd = findUpdate("transactions");
    expect(upd).not.toBeNull();
    expect(boundValue(upd!, "label_category_confidence")).toBe(1);
    expect(boundValue(upd!, "label_category_id")).toBe("c-1");
    // updateTransactions scopes the write to the session user (4th arg userId).
    expect(upd!.values).toContain("u-1");
    expect(upd!.values).toContain("t-1");
  });

  test("clear-category (category_id: null) with confidence omitted → infers category_confidence = 0", async () => {
    const result = await postTransactionRoute.execute(
      makeReq(postTransactionRoute, { transaction_id: "t-1", label: { category_id: null } }, "u-1"),
      fakeRes(),
    );
    expect(result?.status).toBe("success");

    const upd = findUpdate("transactions");
    expect(upd).not.toBeNull();
    expect(boundValue(upd!, "label_category_confidence")).toBe(0);
    expect(boundValue(upd!, "label_category_id")).toBeNull();
  });

  test("caller-set confidence is preserved, not overwritten to 1", async () => {
    const result = await postTransactionRoute.execute(
      makeReq(
        postTransactionRoute,
        { transaction_id: "t-1", label: { category_id: "c-1", category_confidence: 0.42 } },
        "u-1",
      ),
      fakeRes(),
    );
    expect(result?.status).toBe("success");

    const upd = findUpdate("transactions");
    expect(upd).not.toBeNull();
    expect(boundValue(upd!, "label_category_confidence")).toBe(0.42);
  });

  test("surfaces a DB error as a failed response", async () => {
    failQueries = true;
    const req = makeReq(postTransactionRoute, { transaction_id: "t-1", label: { memo: "x" } }, "u-1");
    // No category_id in the label, so getPrevLabel is skipped and the UPDATE is
    // the only query: the repo swallows the rejection into an errorResult(500),
    // the route's `status >= 400` check rethrows, and Route.execute converts the
    // throw into an error response (it does not reject).
    const result = await postTransactionRoute.execute(req, fakeRes());
    expect(result?.status).toBe("error");
  });
});

describe("post-split-transaction route", () => {
  test("rejects unauthenticated requests", async () => {
    const result = await postSplitTransactionRoute.execute(
      makeReq(postSplitTransactionRoute, { split_transaction_id: "s-1" }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("rejects a non-object body", async () => {
    const result = await postSplitTransactionRoute.execute(
      makeReq(postSplitTransactionRoute, 42, "u-1"),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("rejects a missing split_transaction_id", async () => {
    const result = await postSplitTransactionRoute.execute(
      makeReq(postSplitTransactionRoute, { label: { category_id: "c-1" } }, "u-1"),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/split_transaction_id/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("set-category with confidence omitted → infers category_confidence = 1", async () => {
    const result = await postSplitTransactionRoute.execute(
      makeReq(
        postSplitTransactionRoute,
        { split_transaction_id: "s-1", label: { category_id: "c-1" } },
        "u-1",
      ),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    expect(result?.body).toEqual({ split_transaction_id: "s-1" });

    const upd = findUpdate("split_transactions");
    expect(upd).not.toBeNull();
    expect(boundValue(upd!, "label_category_confidence")).toBe(1);
    expect(boundValue(upd!, "label_category_id")).toBe("c-1");
  });

  test("clear-category (category_id: null) → infers category_confidence = 0", async () => {
    const result = await postSplitTransactionRoute.execute(
      makeReq(
        postSplitTransactionRoute,
        { split_transaction_id: "s-1", label: { category_id: null } },
        "u-1",
      ),
      fakeRes(),
    );
    expect(result?.status).toBe("success");

    const upd = findUpdate("split_transactions");
    expect(upd).not.toBeNull();
    expect(boundValue(upd!, "label_category_confidence")).toBe(0);
    expect(boundValue(upd!, "label_category_id")).toBeNull();
  });

  test("caller-set confidence is preserved", async () => {
    const result = await postSplitTransactionRoute.execute(
      makeReq(
        postSplitTransactionRoute,
        { split_transaction_id: "s-1", label: { category_id: "c-1", category_confidence: 0.7 } },
        "u-1",
      ),
      fakeRes(),
    );
    expect(result?.status).toBe("success");

    const upd = findUpdate("split_transactions");
    expect(boundValue(upd!, "label_category_confidence")).toBe(0.7);
  });

  test("surfaces a DB error as a failed response", async () => {
    // Matches its sibling routes: updateSplitTransactions swallows the write
    // failure into an errorResult(500), the route's `result.status >= 400`
    // check rethrows, and Route.execute converts the throw into an error
    // response (it does not reject).
    failQueries = true;
    const result = await postSplitTransactionRoute.execute(
      makeReq(
        postSplitTransactionRoute,
        { split_transaction_id: "s-1", label: { category_id: "c-1" } },
        "u-1",
      ),
      fakeRes(),
    );
    expect(result?.status).toBe("error");
  });
});

describe("post-investment-transaction route", () => {
  test("rejects unauthenticated requests", async () => {
    const result = await postInvestmentTransactionRoute.execute(
      makeReq(postInvestmentTransactionRoute, { investment_transaction_id: "i-1" }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("rejects a non-object body", async () => {
    const result = await postInvestmentTransactionRoute.execute(
      makeReq(postInvestmentTransactionRoute, ["array"], "u-1"),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("rejects a missing investment_transaction_id", async () => {
    const result = await postInvestmentTransactionRoute.execute(
      makeReq(postInvestmentTransactionRoute, { label: { category_id: "c-1" } }, "u-1"),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/investment_transaction_id/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("body passes through WITHOUT confidence inference (auto-suggest skips investments)", async () => {
    const result = await postInvestmentTransactionRoute.execute(
      makeReq(
        postInvestmentTransactionRoute,
        { investment_transaction_id: "i-1", label: { category_id: "c-1" } },
        "u-1",
      ),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    expect(result?.body).toEqual({ investment_transaction_id: "i-1" });

    const upd = findUpdate("investment_transactions");
    expect(upd).not.toBeNull();
    expect(boundValue(upd!, "label_category_id")).toBe("c-1");
    // The route does not call inferLabelConfidence, so no confidence column is
    // written — distinguishing it from the other two routes in the trio.
    expect(boundValue(upd!, "label_category_confidence")).toBe(SENTINEL);
    // updateInvestmentTransactions scopes the write to the session user
    // (4th arg userId). Regression guard: dropping the arg loses the
    // scope silently.
    expect(upd!.values).toContain("u-1");
    expect(upd!.values).toContain("i-1");
  });

  test("surfaces a DB error as a failed response", async () => {
    failQueries = true;
    const req = makeReq(
      postInvestmentTransactionRoute,
      { investment_transaction_id: "i-1", label: { category_id: "c-1" } },
      "u-1",
    );
    // Unlike post-split-transaction, this route checks `result.status >= 400`
    // and rethrows; Route.execute converts that into an error response.
    const result = await postInvestmentTransactionRoute.execute(req, fakeRes());
    expect(result?.status).toBe("error");
  });
});
