import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";

// Route-level coverage for the FE→DB label-write trio
// (post-transaction / post-split-transaction / post-investment-transaction).
// The repo functions and `inferLabelConfidence` are unit-tested in isolation;
// what is uncovered is the *wiring* that ties them together — the route reads
// the body, runs the confidence inference, and hands the result to the repo.
//
// Pins behavior at the SQL-param layer: a FakePool intercepts pg, the route is
// driven through `.execute`, and the UPDATE statement's bound values are
// asserted — catching regressions in the route→repo handoff that a repo unit
// test (which writes exactly what it's told) cannot.
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

// `mock.module` is process-global in Bun and `restoreLeaves` only restores the
// `pg` / `bcrypt` leaves, so spread the real module rather than replacing it —
// `alarm.test.ts` drives `resetAlarmState` — and put it back in `afterAll`
// (the post-plaid-hook.test.ts pattern) so sibling files sharing the process
// exercise the real `sendAlarm`.
const realAlarm = { ...(await import("server/lib/alarm")) };

const mockSendAlarm = mock(async (_title: string, _detail: string, _key?: string) => undefined);
mock.module("server/lib/alarm", () => ({ ...realAlarm, sendAlarm: mockSendAlarm }));

const { postTransactionRoute } = await import("./post-transaction");
const { postSplitTransactionRoute } = await import("./post-split-transaction");
const { postInvestmentTransactionRoute } = await import("./post-investment-transaction");

afterAll(() => {
  mock.module("server/lib/alarm", () => realAlarm);
  restoreLeaves();
});

beforeEach(() => {
  // Clear the call log but keep the flag-driven implementation (mockReset would
  // wipe it, and re-setting an impl per test doesn't reliably stick in Bun).
  mockQuery.mockClear();
  mockSendAlarm.mockClear();
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

// The validateFields specs pin the UUID-columned ids and label fields, so
// fixtures carry real UUIDs rather than short shorthands that a UUID column
// would reject in production anyway.
const SPLIT_UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const CATEGORY_UUID = "9b2a44a0-1c23-4d56-8e9f-0a1b2c3d4e5f";
const BUDGET_UUID = "7c1d33b0-2d34-4e67-9fa0-1b2c3d4e5f6a";

/**
 * A malformed typed field must be refused before any SQL and before the alarm
 * path. `failQueries` is armed so a missing guard reaches the FakePool, throws
 * the way Postgres throws on a bad value, and trips both assertions.
 */
const rejects = async (route: AnyRoute, body: unknown, expectedError: string) => {
  failQueries = true;
  const result = await route.execute(makeReq(route, body, "u-1"), fakeRes());
  expect(result?.status).toBe("failed");
  expect(result?.message).toBe(expectedError);
  expect(mockQuery).not.toHaveBeenCalled();
  expect(mockSendAlarm).not.toHaveBeenCalled();
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
      makeReq(postTransactionRoute, { label: { category_id: CATEGORY_UUID } }, "u-1"),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/transaction_id/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("set-category with confidence omitted → infers category_confidence = 1, scoped to user", async () => {
    const result = await postTransactionRoute.execute(
      makeReq(postTransactionRoute, { transaction_id: "t-1", label: { category_id: CATEGORY_UUID } }, "u-1"),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    expect(result?.body).toEqual({ transaction_id: "t-1" });

    const upd = findUpdate("transactions");
    expect(upd).not.toBeNull();
    expect(boundValue(upd!, "label_category_confidence")).toBe(1);
    expect(boundValue(upd!, "label_category_id")).toBe(CATEGORY_UUID);
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
        { transaction_id: "t-1", label: { category_id: CATEGORY_UUID, category_confidence: 0.42 } },
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

  test("a non-number amount is refused before it reaches the DECIMAL column", async () => {
    await rejects(
      postTransactionRoute,
      { transaction_id: "t-1", amount: "abc" },
      "Field amount must be a number",
    );
  });

  test("a non-date date is refused before it reaches the DATE column", async () => {
    for (const value of ["hello", "", "2026-13-45"]) {
      mockQuery.mockClear();
      mockSendAlarm.mockClear();
      await rejects(
        postTransactionRoute,
        { transaction_id: "t-1", date: value },
        "Field date must be a date",
      );
    }
  });

  test("a non-UUID label.budget_id is refused before it reaches the UUID column", async () => {
    await rejects(
      postTransactionRoute,
      { transaction_id: "t-1", label: { budget_id: "nope" } },
      "Field label.budget_id must be a uuid",
    );
  });

  test("a non-UUID label.category_id is refused before it reaches the UUID column", async () => {
    await rejects(
      postTransactionRoute,
      { transaction_id: "t-1", label: { category_id: "nope2" } },
      "Field label.category_id must be a uuid",
    );
  });

  test("a string label.category_confidence is refused before it reaches the FLOAT column", async () => {
    await rejects(
      postTransactionRoute,
      { transaction_id: "t-1", label: { category_confidence: "high" } },
      "Field label.category_confidence must be a number",
    );
  });

  test("a well-formed manual-edit body passes validation and reaches the repo", async () => {
    const result = await postTransactionRoute.execute(
      makeReq(
        postTransactionRoute,
        {
          transaction_id: "t-1",
          amount: 12.34,
          // What the client sends from its `type="date"` input.
          date: "2026-08-24",
          label: { budget_id: BUDGET_UUID },
        },
        "u-1",
      ),
      fakeRes(),
    );
    expect(result?.status).toBe("success");

    const upd = findUpdate("transactions");
    expect(upd).not.toBeNull();
    expect(boundValue(upd!, "amount")).toBe(12.34);
    expect(boundValue(upd!, "label_budget_id")).toBe(BUDGET_UUID);
    expect(mockSendAlarm).not.toHaveBeenCalled();
  });

  test("an explicit null label.budget_id (the client's clear flow) is accepted", async () => {
    const result = await postTransactionRoute.execute(
      makeReq(
        postTransactionRoute,
        { transaction_id: "t-1", label: { budget_id: null, category_id: null } },
        "u-1",
      ),
      fakeRes(),
    );
    expect(result?.status).toBe("success");

    const upd = findUpdate("transactions");
    expect(upd).not.toBeNull();
    expect(boundValue(upd!, "label_budget_id")).toBeNull();
  });
});

describe("post-split-transaction route", () => {
  test("rejects unauthenticated requests", async () => {
    const result = await postSplitTransactionRoute.execute(
      makeReq(postSplitTransactionRoute, { split_transaction_id: SPLIT_UUID }),
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
      makeReq(postSplitTransactionRoute, { label: { category_id: CATEGORY_UUID } }, "u-1"),
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
        { split_transaction_id: SPLIT_UUID, label: { category_id: CATEGORY_UUID } },
        "u-1",
      ),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    expect(result?.body).toEqual({ split_transaction_id: SPLIT_UUID });

    const upd = findUpdate("split_transactions");
    expect(upd).not.toBeNull();
    expect(boundValue(upd!, "label_category_confidence")).toBe(1);
    expect(boundValue(upd!, "label_category_id")).toBe(CATEGORY_UUID);
  });

  test("clear-category (category_id: null) → infers category_confidence = 0", async () => {
    const result = await postSplitTransactionRoute.execute(
      makeReq(
        postSplitTransactionRoute,
        { split_transaction_id: SPLIT_UUID, label: { category_id: null } },
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
        { split_transaction_id: SPLIT_UUID, label: { category_id: CATEGORY_UUID, category_confidence: 0.7 } },
        "u-1",
      ),
      fakeRes(),
    );
    expect(result?.status).toBe("success");

    const upd = findUpdate("split_transactions");
    expect(boundValue(upd!, "label_category_confidence")).toBe(0.7);
  });

  test("update WHERE is scoped to caller's user_id (cross-user write guard)", async () => {
    const result = await postSplitTransactionRoute.execute(
      makeReq(
        postSplitTransactionRoute,
        { split_transaction_id: SPLIT_UUID, label: { category_id: CATEGORY_UUID } },
        "u-1",
      ),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    // Assert the guard is a WHERE predicate binding the caller's id, not a bare
    // `values.toContain("u-1")` — the latter passes vacuously for a refactor that
    // drops the guard but still SETs user_id. Both the PK and the user_id scope
    // must key the WHERE clause.
    const upd = findUpdate("split_transactions");
    const whereUserId = upd!.sql.match(/WHERE[\s\S]*?\buser_id\s*=\s*\$(\d+)/i);
    const wherePk = upd!.sql.match(/WHERE[\s\S]*?\bsplit_transaction_id\s*=\s*\$(\d+)/i);
    expect(whereUserId).not.toBeNull();
    expect(wherePk).not.toBeNull();
    expect(upd!.values[Number(whereUserId![1]) - 1]).toBe("u-1");
    expect(upd!.values[Number(wherePk![1]) - 1]).toBe(SPLIT_UUID);
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
        { split_transaction_id: SPLIT_UUID, label: { category_id: CATEGORY_UUID } },
        "u-1",
      ),
      fakeRes(),
    );
    expect(result?.status).toBe("error");
  });

  test("a non-UUID split_transaction_id is refused before it reaches the WHERE clause", async () => {
    await rejects(
      postSplitTransactionRoute,
      { split_transaction_id: "not-a-uuid" },
      "Field split_transaction_id must be a uuid",
    );
  });

  test("a non-number amount is refused before it reaches the DECIMAL column", async () => {
    await rejects(
      postSplitTransactionRoute,
      { split_transaction_id: SPLIT_UUID, amount: "abc" },
      "Field amount must be a number",
    );
  });

  test("a non-date date is refused before it reaches the DATE column", async () => {
    for (const value of ["bad", "2026-02-30"]) {
      mockQuery.mockClear();
      mockSendAlarm.mockClear();
      await rejects(
        postSplitTransactionRoute,
        { split_transaction_id: SPLIT_UUID, date: value },
        "Field date must be a date",
      );
    }
  });

  test("a non-UUID label.budget_id is refused before it reaches the UUID column", async () => {
    await rejects(
      postSplitTransactionRoute,
      { split_transaction_id: SPLIT_UUID, label: { budget_id: "nope" } },
      "Field label.budget_id must be a uuid",
    );
  });

  test("the add flow's whole-instance body passes validation and reaches the repo", async () => {
    const result = await postSplitTransactionRoute.execute(
      makeReq(
        postSplitTransactionRoute,
        {
          split_transaction_id: SPLIT_UUID,
          transaction_id: "t-1",
          account_id: "a-1",
          amount: 6.17,
          // What the client serializes, via `getDateTimeString`.
          date: "2026-08-24T00:00:00",
          custom_name: "Unknown",
          label: { budget_id: null, category_id: null, memo: null, category_confidence: null },
        },
        "u-1",
      ),
      fakeRes(),
    );
    expect(result?.status).toBe("success");

    const upd = findUpdate("split_transactions");
    expect(upd).not.toBeNull();
    expect(boundValue(upd!, "amount")).toBe(6.17);
    expect(mockSendAlarm).not.toHaveBeenCalled();
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
      makeReq(postInvestmentTransactionRoute, { label: { category_id: CATEGORY_UUID } }, "u-1"),
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
        { investment_transaction_id: "i-1", label: { category_id: CATEGORY_UUID } },
        "u-1",
      ),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    expect(result?.body).toEqual({ investment_transaction_id: "i-1" });

    const upd = findUpdate("investment_transactions");
    expect(upd).not.toBeNull();
    expect(boundValue(upd!, "label_category_id")).toBe(CATEGORY_UUID);
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
      { investment_transaction_id: "i-1", label: { category_id: CATEGORY_UUID } },
      "u-1",
    );
    // Unlike post-split-transaction, this route checks `result.status >= 400`
    // and rethrows; Route.execute converts that into an error response.
    const result = await postInvestmentTransactionRoute.execute(req, fakeRes());
    expect(result?.status).toBe("error");
  });

  test("a non-number amount is refused before it reaches the DECIMAL column", async () => {
    await rejects(
      postInvestmentTransactionRoute,
      { investment_transaction_id: "i-1", amount: "abc" },
      "Field amount must be a number",
    );
  });

  test("a non-number quantity is refused before it reaches the DECIMAL column", async () => {
    await rejects(
      postInvestmentTransactionRoute,
      { investment_transaction_id: "i-1", quantity: "many" },
      "Field quantity must be a number",
    );
  });

  test("a non-number price is refused before it reaches the DECIMAL column", async () => {
    await rejects(
      postInvestmentTransactionRoute,
      { investment_transaction_id: "i-1", price: {} },
      "Field price must be a number",
    );
  });

  test("a non-date date is refused before it reaches the DATE column", async () => {
    await rejects(
      postInvestmentTransactionRoute,
      { investment_transaction_id: "i-1", date: "2026-13-45" },
      "Field date must be a date",
    );
  });

  test("a non-UUID label.budget_id is refused before it reaches the UUID column", async () => {
    await rejects(
      postInvestmentTransactionRoute,
      { investment_transaction_id: "i-1", label: { budget_id: "nope" } },
      "Field label.budget_id must be a uuid",
    );
  });

  test("a well-formed manual-edit body passes validation and reaches the repo", async () => {
    const result = await postInvestmentTransactionRoute.execute(
      makeReq(
        postInvestmentTransactionRoute,
        {
          investment_transaction_id: "i-1",
          amount: 100.5,
          quantity: 2.5,
          price: 40.2,
          date: "2026-08-24",
          label: { budget_id: BUDGET_UUID, category_id: null },
        },
        "u-1",
      ),
      fakeRes(),
    );
    expect(result?.status).toBe("success");

    const upd = findUpdate("investment_transactions");
    expect(upd).not.toBeNull();
    expect(boundValue(upd!, "quantity")).toBe(2.5);
    expect(boundValue(upd!, "label_budget_id")).toBe(BUDGET_UUID);
    expect(mockSendAlarm).not.toHaveBeenCalled();
  });
});
