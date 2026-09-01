import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";

// `POST /api/account` is purely UPDATE — create lives on the sibling
// `GET /api/new-account` mint route. A FakePool intercepts pg so the
// statement the route actually issues can be asserted: `updateAccounts`
// must strip `item_id` + `institution_id` so an edit body can't reparent
// a row or persist an arbitrary institution string; a body naming an
// `account_id` that does not exist yet must answer `Account not found.`
// instead of an ambiguous 304-that-looks-like-success.

type Row = Record<string, unknown>;

const db = {
  updateReturns: [] as Row[],
  updateError: null as Error | null,
};

const mockQuery = mock(async (sql: string, _values?: unknown[]) => {
  const rows = (() => {
    if (/^\s*UPDATE\s+accounts\b/i.test(sql)) {
      if (db.updateError) throw db.updateError;
      return db.updateReturns;
    }
    return [];
  })();
  return { rows: rows as unknown[], rowCount: rows.length as number | null };
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

const { postAccountRoute } = await import("./post-account");

afterAll(() => {
  mock.module("server/lib/alarm", () => realAlarm);
  restoreLeaves();
});

beforeEach(() => {
  mockQuery.mockClear();
  mockSendAlarm.mockClear();
  db.updateReturns = [];
  db.updateError = null;
});

function makeReq(body: unknown, userId?: string) {
  return {
    method: "POST",
    path: "/account",
    url: "http://x/api/account",
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
  } as unknown as Parameters<typeof postAccountRoute.execute>[0];
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
  }) as unknown as Parameters<typeof postAccountRoute.execute>[1];

const findStatement = (re: RegExp): { sql: string; values: unknown[] } | null => {
  for (const call of mockQuery.mock.calls) {
    const sql = call[0] as string;
    if (re.test(sql)) return { sql, values: (call[1] ?? []) as unknown[] };
  }
  return null;
};

const UPDATE_ACCOUNTS = /^\s*UPDATE\s+accounts\b/i;

describe("post-account validation", () => {
  test("rejects unauthenticated requests", async () => {
    const result = await postAccountRoute.execute(
      makeReq({ account_id: "acc-x", custom_name: "renamed" }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("rejects a non-object body", async () => {
    const result = await postAccountRoute.execute(makeReq("not an object", "u-1"), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/body/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("rejects a missing account_id", async () => {
    const result = await postAccountRoute.execute(makeReq({ custom_name: "renamed" }, "u-1"), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/account_id/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("post-account edit path", () => {
  test("updates an existing account and never inserts", async () => {
    db.updateReturns = [{ account_id: "acc-1" }];
    const result = await postAccountRoute.execute(
      makeReq({ account_id: "acc-1", custom_name: "New Name" }, "u-1"),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    expect((result?.body as { account_id: string }).account_id).toBe("acc-1");
    expect(findStatement(UPDATE_ACCOUNTS)).not.toBeNull();
    expect(findStatement(/^\s*INSERT\s+INTO\s+accounts\b/i)).toBeNull();
  });

  test("costs exactly one statement — no existence probe on the hot edit path", async () => {
    db.updateReturns = [{ account_id: "acc-1" }];
    await postAccountRoute.execute(
      makeReq({ account_id: "acc-1", custom_name: "New Name" }, "u-1"),
      fakeRes(),
    );
    const accountsStatements = mockQuery.mock.calls.filter(([sql]) =>
      /\baccounts\b/i.test(sql as string),
    );
    expect(accountsStatements).toHaveLength(1);
    expect((accountsStatements[0][0] as string)).toMatch(UPDATE_ACCOUNTS);
  });

  test("reports `Account not found` when the update matches no row (id does not exist)", async () => {
    db.updateReturns = [];
    const result = await postAccountRoute.execute(
      makeReq({ account_id: "ghost", custom_name: "Ghost" }, "u-1"),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/account not found/i);
  });

  test("surfaces a DB fault as a 500-class response — not the client-friendly `Account not found`", async () => {
    db.updateError = new Error("DB unavailable");
    const result = await postAccountRoute.execute(
      makeReq({ account_id: "acc-1", custom_name: "renamed" }, "u-1"),
      fakeRes(),
    );
    // Route.execute catches the throw, alarms, and returns the framework's
    // internal-error shape. The distinguishing property is that the response
    // is NOT the ambiguous "Account not found" — a caller can't confuse a
    // DB fault with a missing row.
    expect(result?.status).not.toBe("success");
    expect((result as { message?: string })?.message ?? "").not.toMatch(/account not found/i);
  });

  test("never writes institution_id — the column is create-only", async () => {
    db.updateReturns = [{ account_id: "acc-1" }];
    await postAccountRoute.execute(
      makeReq(
        { account_id: "acc-1", custom_name: "renamed", institution_id: "hacker-owned-institution" },
        "u-1",
      ),
      fakeRes(),
    );
    const update = findStatement(UPDATE_ACCOUNTS);
    expect(update).not.toBeNull();
    expect(update!.sql).not.toMatch(/institution_id/i);
    expect(update!.values).not.toContain("hacker-owned-institution");
  });

  test("never writes item_id — an edit cannot reparent an account (mint route is the sole writer)", async () => {
    db.updateReturns = [{ account_id: "acc-1" }];
    await postAccountRoute.execute(
      makeReq(
        { account_id: "acc-1", custom_name: "renamed", item_id: "other-users-item" },
        "u-1",
      ),
      fakeRes(),
    );
    const update = findStatement(UPDATE_ACCOUNTS);
    expect(update).not.toBeNull();
    expect(update!.sql).not.toMatch(/\bitem_id\b/i);
    expect(update!.values).not.toContain("other-users-item");
  });

  test("scopes the UPDATE to the requesting user's user_id", async () => {
    db.updateReturns = [{ account_id: "acc-1" }];
    await postAccountRoute.execute(
      makeReq({ account_id: "acc-1", custom_name: "renamed" }, "u-42"),
      fakeRes(),
    );
    const update = findStatement(UPDATE_ACCOUNTS);
    expect(update).not.toBeNull();
    expect(update!.sql).toMatch(/user_id\s*=/i);
    expect(update!.values).toContain("u-42");
  });

  test("excludes soft-deleted rows — updating one would report a change no user can see", async () => {
    db.updateReturns = [{ account_id: "acc-1" }];
    await postAccountRoute.execute(
      makeReq({ account_id: "acc-1", custom_name: "renamed" }, "u-1"),
      fakeRes(),
    );
    const update = findStatement(UPDATE_ACCOUNTS);
    expect(update).not.toBeNull();
    expect(update!.sql).toMatch(/is_deleted/i);
  });
});

describe("post-account typed body fields", () => {
  const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

  // Stage a matching row AND arm the write to fail the way Postgres fails on a
  // bad value, so a missing guard reaches the query and pages the alarm.
  const rejects = async (body: unknown, expectedError: string) => {
    db.updateReturns = [{ account_id: "acc-1" }];
    db.updateError = new Error('invalid input syntax for type numeric: "abc"');

    const result = await postAccountRoute.execute(makeReq(body, "u-1"), fakeRes());

    expect(result?.status).toBe("failed");
    expect((result as { message?: string })?.message).toBe(expectedError);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockSendAlarm).not.toHaveBeenCalled();
  };

  test("a string in balances.current is refused before SQL", async () => {
    await rejects(
      { account_id: "acc-1", balances: { current: "abc" } },
      "Field balances.current must be a number",
    );
  });

  test("a non-UUID label.budget_id is refused before SQL", async () => {
    await rejects(
      { account_id: "acc-1", label: { budget_id: "not-a-uuid" } },
      "Field label.budget_id must be a uuid",
    );
  });

  test("a string in a boolean column is refused before SQL", async () => {
    await rejects({ account_id: "acc-1", hide: "true" }, "Field hide must be a boolean");
  });

  test("a non-object balances is refused before SQL", async () => {
    await rejects({ account_id: "acc-1", balances: "broke" }, "Field balances must be an object");
  });

  test("a well-formed partial body passes validation and reaches the repo", async () => {
    db.updateReturns = [{ account_id: "acc-1" }];
    const result = await postAccountRoute.execute(
      makeReq(
        {
          account_id: "acc-1",
          hide: true,
          label: { budget_id: UUID },
          balances: { current: -12.5 },
        },
        "u-1",
      ),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    expect(findStatement(UPDATE_ACCOUNTS)).not.toBeNull();
    expect(mockSendAlarm).not.toHaveBeenCalled();
  });
});
