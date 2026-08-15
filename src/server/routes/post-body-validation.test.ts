// Route-boundary body validation (issue 671).
//
// A client type error must be answered as `status: "failed"` BEFORE any value
// reaches SQL. Without the guard, `{ balances: { current: "abc" } }` travels
// into a DECIMAL column and a non-UUID `label.budget_id` into a UUID column,
// Postgres raises `22P02 invalid_text_representation` at the write, the repo
// collapses it into an error result, the route throws, and `Route.execute`
// answers 500 **and** calls `sendAlarm`.
//
// The alarm half is what makes this more than cosmetic: a client type error
// must not page, and must not spend a slot of `alarm.ts`'s global per-window
// send ceiling that a real fault — route 5xx, uncaughtException,
// unhandledRejection, sync failure — needs.
//
// So each case here pins three things at once: the status is `failed`, no SQL
// was issued, and `sendAlarm` was never called. Asserting only the status
// would still pass on an implementation that validated *after* the write.

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

// `mock.module` is process-global in Bun and `restoreLeaves` only restores the
// `pg` / `bcrypt` leaves, so spread the real module rather than replacing it —
// `alarm.test.ts` drives `resetAlarmState` — and put it back in `afterAll`
// (the post-plaid-hook.test.ts pattern) so sibling files sharing the process
// exercise the real `sendAlarm`.
const realAlarm = { ...(await import("server/lib/alarm")) };

const mockSendAlarm = mock(
  async (_title: string, _detail: string, _key?: string) => undefined
);
mock.module("server/lib/alarm", () => ({
  ...realAlarm,
  sendAlarm: mockSendAlarm,
}));

const { postAccountRoute } = await import("./accounts/post-account");
const { postBudgetRoute } = await import("./budgets/post-budget");

afterAll(() => {
  mock.module("server/lib/alarm", () => realAlarm);
  restoreLeaves();
});

type AnyRoute = typeof postAccountRoute | typeof postBudgetRoute;

const makeReq = (route: AnyRoute, body: unknown) =>
  ({
    method: "POST",
    path: "/x",
    url: "http://x/api/x",
    headers: {},
    query: {},
    body,
    session: {
      id: "s-1",
      user: { user_id: "11111111-1111-1111-1111-111111111111", username: "test" },
      regenerate() {},
      destroy() {},
    },
    ip: "127.0.0.1",
  }) as unknown as Parameters<typeof route.execute>[0];

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
  }) as unknown as Parameters<typeof postAccountRoute.execute>[1];

beforeEach(() => {
  mockQuery.mockClear();
  mockSendAlarm.mockClear();
});

const ACCOUNT_ID = "acc-1";
const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

const rejects = async (route: AnyRoute, body: unknown, expectedError: string) => {
  const result = (await route.execute(makeReq(route, body), fakeRes())) as {
    status: string;
    message?: string;
  };
  expect(result.status).toBe("failed");
  expect(result.message).toBe(expectedError);
  // The point of validating at the boundary: nothing reached Postgres…
  expect(mockQuery).not.toHaveBeenCalled();
  // …so nothing could page.
  expect(mockSendAlarm).not.toHaveBeenCalled();
};

describe("POST /api/account — typed body fields", () => {
  test("a string in balances.current is refused before SQL", async () => {
    await rejects(
      postAccountRoute,
      { account_id: ACCOUNT_ID, balances: { current: "abc" } },
      "Field balances.current must be a number"
    );
  });

  test("a non-UUID label.budget_id is refused before SQL", async () => {
    await rejects(
      postAccountRoute,
      { account_id: ACCOUNT_ID, label: { budget_id: "not-a-uuid" } },
      "Field label.budget_id must be a uuid"
    );
  });

  test("a string in a boolean column is refused before SQL", async () => {
    await rejects(
      postAccountRoute,
      { account_id: ACCOUNT_ID, hide: "true" },
      "Field hide must be a boolean"
    );
  });

  test("a non-object balances is refused before SQL", async () => {
    await rejects(
      postAccountRoute,
      { account_id: ACCOUNT_ID, balances: "broke" },
      "Field balances must be an object"
    );
  });

  test("a well-formed partial body passes validation and reaches the repo", async () => {
    await postAccountRoute.execute(
      makeReq(postAccountRoute, {
        account_id: ACCOUNT_ID,
        hide: true,
        label: { budget_id: UUID },
        balances: { current: -12.5 },
      }),
      fakeRes()
    );
    // The repo call fails against the empty FakePool — irrelevant here. What
    // this pins is that validation did NOT short-circuit a legitimate body:
    // the guard has to reject bad input without rejecting good input.
    expect(mockQuery).toHaveBeenCalled();
  });
});

describe("POST /api/budget — typed body fields", () => {
  test("a non-UUID budget_id is refused before it reaches the WHERE clause", async () => {
    await rejects(
      postBudgetRoute,
      { budget_id: "not-a-uuid" },
      "Field budget_id must be a uuid"
    );
  });

  test("a string in the roll_over boolean column is refused before SQL", async () => {
    await rejects(
      postBudgetRoute,
      { budget_id: UUID, roll_over: "yes" },
      "Field roll_over must be a boolean"
    );
  });

  test("a well-formed body passes validation and reaches the repo", async () => {
    await postBudgetRoute.execute(
      makeReq(postBudgetRoute, { budget_id: UUID, name: "Groceries", roll_over: true }),
      fakeRes()
    );
    expect(mockQuery).toHaveBeenCalled();
  });
});
