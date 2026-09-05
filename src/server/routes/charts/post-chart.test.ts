import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";

type Row = Record<string, unknown>;

const db = {
  updateReturns: [] as Row[],
  updateError: null as Error | null,
};

const mockQuery = mock(async (sql: string, _values?: unknown[]) => {
  const rows = (() => {
    if (/^\s*UPDATE\s+charts\b/i.test(sql)) {
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

const { postChartRoute } = await import("./post-chart");

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
    path: "/chart",
    url: "http://x/api/chart",
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
  }) as unknown as Parameters<typeof postChartRoute.execute>[0];

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
  }) as unknown as Parameters<typeof postChartRoute.execute>[1];

const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

describe("post-chart typed body fields", () => {
  // Stage a matching row AND arm the write to fail the way Postgres fails on a
  // bad value, so a missing guard reaches the query and pages the alarm.
  const rejects = async (body: unknown, expectedError: string) => {
    db.updateReturns = [{ chart_id: UUID }];
    db.updateError = new Error('invalid input syntax for type uuid: "not-a-uuid"');

    const result = await postChartRoute.execute(makeReq(body), fakeRes());

    expect(result?.status).toBe("failed");
    expect((result as { message?: string })?.message).toBe(expectedError);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockSendAlarm).not.toHaveBeenCalled();
  };

  test("a non-UUID chart_id is refused before it reaches the WHERE clause", async () => {
    await rejects({ chart_id: "not-a-uuid", name: "n" }, "Field chart_id must be a uuid");
  });

  test("a non-string name is refused before it reaches the VARCHAR column", async () => {
    await rejects({ chart_id: UUID, name: { a: 1 } }, "Field name must be a string");
  });

  test("a non-string type is refused before it reaches the VARCHAR column", async () => {
    await rejects({ chart_id: UUID, type: { a: 1 } }, "Field type must be a string");
  });

  test("a non-string configuration is refused — the client always sends a JSON string", async () => {
    for (const configuration of [{ account_ids: [] }, 5, null]) {
      mockQuery.mockClear();
      mockSendAlarm.mockClear();
      await rejects({ chart_id: UUID, configuration }, "Field configuration must be a string");
    }
  });

  test("a well-formed body passes validation and reaches the repo", async () => {
    db.updateReturns = [{ chart_id: UUID }];
    const result = await postChartRoute.execute(
      makeReq({
        chart_id: UUID,
        name: "Net worth",
        type: "balance",
        // What the client serializes, via `Chart.toJSON`.
        configuration: JSON.stringify({ account_ids: [], budget_ids: [] }),
      }),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    expect(mockQuery).toHaveBeenCalled();
    expect(mockSendAlarm).not.toHaveBeenCalled();
  });
});
