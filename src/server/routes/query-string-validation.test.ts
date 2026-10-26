import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakePg, restoreLeaves } from "test-helpers";

// Armed for the malformed-input tests: if a guard is missing, the route
// reaches SQL, the fake driver throws the way Postgres throws on a bad
// UUID/TIMESTAMPTZ literal, and `Route.execute` answers 500 + an alarm.
// With the guard present, no query runs and no alarm fires.
let failQueries = false;
const { pg, mockQuery, mockClientQuery, clearQueryMocks } = createFakePg(async () => {
  if (failQueries) throw new Error('invalid input syntax for type uuid: "not-a-uuid"');
  return { rows: [], rowCount: 0 as number | null };
});

mock.module("pg", () => pg);

// Same alarm-mock pattern as the post-* route tests: spread the real module
// so only `sendAlarm` is mocked, and restore it afterwards so sibling files
// exercise the real alarm.
const realAlarm = { ...(await import("server/lib/alarm")) };
const mockSendAlarm = mock(async (_title: string, _detail: string, _key?: string) => undefined);
mock.module("server/lib/alarm", () => ({ ...realAlarm, sendAlarm: mockSendAlarm }));

const { deleteBudgetRoute } = await import("./budgets/delete-budget");
const { deleteSectionRoute } = await import("./budgets/delete-section");
const { deleteCategoryRoute } = await import("./budgets/delete-category");
const { deleteChartRoute } = await import("./charts/delete-chart");
const { deleteSplitTransactionRoute } = await import("./accounts/delete-split-transaction");
const { deleteSnapshotRoute } = await import("./accounts/delete-snapshot");
const { getTransactionsRoute } = await import("./accounts/get-transactions");
const { getSplitTransactionsRoute } = await import("./accounts/get-split-transactions");
const { getSnapshotsRoute } = await import("./accounts/get-snapshots");
const { getTransfersRoute } = await import("./transfers/get-transfers");

afterAll(() => {
  mock.module("server/lib/alarm", () => realAlarm);
  restoreLeaves();
});

beforeEach(() => {
  clearQueryMocks();
  mockClientQuery.mockClear();
  mockSendAlarm.mockClear();
  failQueries = false;
});

const USER = { user_id: "11111111-1111-1111-1111-111111111111", username: "test" };
const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

function makeReq(method: string, path: string, query: Record<string, unknown>) {
  return {
    method,
    path,
    url: `http://x/api${path}`,
    headers: {},
    query,
    body: undefined,
    session: {
      id: "s-1",
      user: USER,
      regenerate() {},
      destroy() {},
    },
    ip: "127.0.0.1",
    setIdleTimeout() {},
  } as unknown as Parameters<typeof deleteBudgetRoute.execute>[0];
}

function fakeRes() {
  const res = {
    statusCode: 200,
    headersSent: false,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    write() {
      return true;
    },
    end() {},
  };
  return res as unknown as Parameters<typeof deleteBudgetRoute.execute>[1];
}

const DELETE_ROUTES = [
  ["DELETE /budget", deleteBudgetRoute],
  ["DELETE /section", deleteSectionRoute],
  ["DELETE /category", deleteCategoryRoute],
  ["DELETE /chart", deleteChartRoute],
  ["DELETE /split-transaction", deleteSplitTransactionRoute],
] as const;

const GET_ROUTES = [
  ["GET /transactions", getTransactionsRoute],
  ["GET /split-transactions", getSplitTransactionsRoute],
  ["GET /snapshots", getSnapshotsRoute],
  ["GET /transfers", getTransfersRoute],
] as const;

describe("query-string validation", () => {
  for (const [label, route] of DELETE_ROUTES) {
    test(`${label} refuses a malformed ?id= before SQL, with no alarm`, async () => {
      failQueries = true;
      const res = fakeRes();
      const result = await route.execute(
        makeReq("DELETE", route.path, { id: "not-a-uuid" }),
        res,
      );
      expect(result?.status).toBe("failed");
      expect((result as { message?: string }).message).toBe("Field id must be a uuid");
      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockClientQuery).not.toHaveBeenCalled();
      expect(mockSendAlarm).not.toHaveBeenCalled();
      expect((res as unknown as { statusCode: number }).statusCode).toBe(200);
    });

    test(`${label} passes a well-formed ?id= through to the repo`, async () => {
      const result = await route.execute(
        makeReq("DELETE", route.path, { id: UUID }),
        fakeRes(),
      );
      expect(result?.status).toBe("success");
      // deleteSection runs entirely inside withTransaction, so its
      // statements land on the transaction client, not the pool query.
      expect(mockQuery.mock.calls.length + mockClientQuery.mock.calls.length).toBeGreaterThan(0);
      expect(mockSendAlarm).not.toHaveBeenCalled();
    });
  }

  for (const [label, route] of GET_ROUTES) {
    test(`${label} refuses a malformed ?start-date= before SQL, with no alarm`, async () => {
      failQueries = true;
      const res = fakeRes();
      const result = await route.execute(
        makeReq("GET", route.path, { "start-date": "garbage" }),
        res,
      );
      expect(result?.status).toBe("failed");
      expect((result as { message?: string }).message).toBe("Field start-date must be a date");
      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockClientQuery).not.toHaveBeenCalled();
      expect(mockSendAlarm).not.toHaveBeenCalled();
      expect((res as unknown as { statusCode: number }).statusCode).toBe(200);
    });
  }

  // /transfers reads no end-date, so it is not in this loop.
  for (const [label, route] of GET_ROUTES.filter(([, r]) => r !== getTransfersRoute)) {
    test(`${label} refuses a non-calendar ?end-date= (2026-02-30) before SQL`, async () => {
      failQueries = true;
      const result = await route.execute(
        makeReq("GET", route.path, { "end-date": "2026-02-30" }),
        fakeRes(),
      );
      expect(result?.status).toBe("failed");
      expect((result as { message?: string }).message).toBe("Field end-date must be a date");
      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockClientQuery).not.toHaveBeenCalled();
      expect(mockSendAlarm).not.toHaveBeenCalled();
    });
  }

  test("a well-formed ?start-date= is not a failed answer on any GET route", async () => {
    for (const [_label, route] of GET_ROUTES) {
      clearQueryMocks();
      mockSendAlarm.mockClear();
      const result = await route.execute(
        makeReq("GET", route.path, { "start-date": "2026-01-15" }),
        fakeRes(),
      );
      // The transaction/snapshot GETs return a lazy JsonStream, not a plain
      // body, so the assertion here is "not a failed answer" rather than a
      // body shape; the malformed tests above carry the guard itself.
      expect((result as { status?: string } | null)?.status).not.toBe("failed");
      expect(mockSendAlarm).not.toHaveBeenCalled();
    }
  });

  test("an empty ?start-date= counts as absent on any GET route, not a failed answer", async () => {
    for (const [_label, route] of GET_ROUTES) {
      clearQueryMocks();
      mockSendAlarm.mockClear();
      const result = await route.execute(
        makeReq("GET", route.path, { "start-date": "" }),
        fakeRes(),
      );
      // optionalQueryString maps "" to undefined, so the date guard sees
      // no value and the route proceeds exactly as with no parameter.
      expect((result as { status?: string } | null)?.status).not.toBe("failed");
      expect(mockSendAlarm).not.toHaveBeenCalled();
    }
  });

  test("negative control: DELETE /snapshot's ?id= is VARCHAR, so a malformed id is a clean no-op, not a 500", async () => {
    const result = await deleteSnapshotRoute.execute(
      makeReq("DELETE", "/snapshot", { id: "not-a-uuid" }),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    expect(mockQuery).toHaveBeenCalled();
    expect(mockSendAlarm).not.toHaveBeenCalled();
  });
});
