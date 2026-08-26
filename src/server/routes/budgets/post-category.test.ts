import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";

type Row = Record<string, unknown>;

const db = {
  updateReturns: [] as Row[],
  updateError: null as Error | null,
};

const mockQuery = mock(async (sql: string, _values?: unknown[]) => {
  const rows = (() => {
    if (/^\s*UPDATE\s+categories\b/i.test(sql)) {
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

const { postCategoryRoute } = await import("./post-category");

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

const makeReq = (body: unknown) =>
  ({
    method: "POST",
    path: "/category",
    url: "http://x/api/category",
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
  }) as unknown as Parameters<typeof postCategoryRoute.execute>[0];

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
  }) as unknown as Parameters<typeof postCategoryRoute.execute>[1];

const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

describe("post-category typed body fields", () => {
  const rejects = async (body: unknown, expectedError: string) => {
    db.updateReturns = [{ category_id: UUID }];
    db.updateError = new Error('invalid input syntax for type date: "hello"');

    const result = await postCategoryRoute.execute(makeReq(body), fakeRes());

    expect(result?.status).toBe("failed");
    expect((result as { message?: string })?.message).toBe(expectedError);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockSendAlarm).not.toHaveBeenCalled();
  };

  test("a non-UUID category_id is refused before it reaches the WHERE clause", async () => {
    await rejects({ category_id: "not-a-uuid" }, "Field category_id must be a uuid");
  });

  test("a string in the roll_over boolean column is refused before SQL", async () => {
    await rejects({ category_id: UUID, roll_over: "yes" }, "Field roll_over must be a boolean");
  });

  test("a non-date roll_over_start_date is refused before it reaches the DATE column", async () => {
    for (const value of ["hello", "", "2026-02-30"]) {
      mockQuery.mockClear();
      mockSendAlarm.mockClear();
      await rejects(
        { category_id: UUID, roll_over_start_date: value },
        "Field roll_over_start_date must be a date",
      );
    }
  });

  test("a well-formed body passes validation and reaches the repo", async () => {
    db.updateReturns = [{ category_id: UUID }];
    const result = await postCategoryRoute.execute(
      makeReq({
        category_id: UUID,
        name: "Groceries",
        roll_over: true,
        // What the client serializes, via `getDateTimeString`.
        roll_over_start_date: "2026-08-24T00:00:00",
      }),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    expect(mockQuery).toHaveBeenCalled();
    expect(mockSendAlarm).not.toHaveBeenCalled();
  });
});
