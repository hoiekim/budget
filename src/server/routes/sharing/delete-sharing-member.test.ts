import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";

const { driver, mockUnsafe, mockReservedUnsafe, resetSqlMocks } = createFakeSql();

mock.module("../../lib/postgres/sql-driver", () => driver);

const { deleteSharingMemberRoute } = await import("./delete-sharing-member");
const { registerSubscriber, unregisterSubscriber } = await import("server/lib/realtime");

afterAll(restoreLeaves);

const CALLER = { user_id: "f6000000-0000-4000-8000-000000000001", username: "caller" };
const PEER = { user_id: "f6000000-0000-4000-8000-000000000002", username: "peer" };
const REMOVED = { user_id: "f6000000-0000-4000-8000-000000000003", username: "removed" };
const OUTSIDER = { user_id: "f6000000-0000-4000-8000-000000000004", username: "outsider" };

const GROUP_LOOKUP = /SELECT unnest\(sharing_user_ids\(\$1\)\)/i;
const MEMBERS_DELETE = /^\s*DELETE FROM sharing_members\b/i;

/** The caller's sharing group before the removal, the caller included. */
let former: string[] = [];

const transactionRouter = async (sql: string) => {
  if (GROUP_LOOKUP.test(sql)) {
    return { rows: former.map((user_id) => ({ user_id })), rowCount: former.length };
  }
  return { rows: [], rowCount: 0 };
};

type Sent = { event: string; payload: unknown };
type Listener = Parameters<typeof registerSubscriber>[1];
const subscriptions: [string, Listener][] = [];

/** Opens a connection as `user` and answers the events it receives. */
const listen = (user: { user_id: string }): Sent[] => {
  const sent: Sent[] = [];
  const subscriber: Listener = {
    send: (event, payload) => {
      sent.push({ event, payload });
    },
    close: () => {},
  };
  registerSubscriber(user.user_id, subscriber);
  subscriptions.push([user.user_id, subscriber]);
  return sent;
};

/** Nothing here is awaited after the response, but a stray emit would land by now. */
const settle = () => Bun.sleep(0);

let inbox: { caller: Sent[]; peer: Sent[]; removed: Sent[]; outsider: Sent[] };

beforeEach(() => {
  resetSqlMocks();
  mockReservedUnsafe.mockImplementation(transactionRouter);
  former = [CALLER.user_id, PEER.user_id, REMOVED.user_id];
  inbox = {
    caller: listen(CALLER),
    peer: listen(PEER),
    removed: listen(REMOVED),
    outsider: listen(OUTSIDER),
  };
});

afterEach(() => {
  for (const [userId, subscriber] of subscriptions.splice(0)) unregisterSubscriber(userId, subscriber);
});

function makeReq(
  query: Record<string, unknown>,
  opts: { user?: { user_id: string; username: string } | null; headers?: Record<string, string | string[]> } = {},
) {
  const user = opts.user === undefined ? CALLER : opts.user;
  return {
    method: "DELETE",
    path: "/sharing/member",
    url: "http://x/api/sharing/member",
    headers: opts.headers ?? {},
    query,
    body: undefined,
    session: {
      id: "s-1",
      user: user ?? undefined,
      regenerate() {},
      destroy() {},
    },
    ip: "127.0.0.1",
  } as unknown as Parameters<typeof deleteSharingMemberRoute.execute>[0];
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
  }) as unknown as Parameters<typeof deleteSharingMemberRoute.execute>[1];

const inTransaction = (matcher: RegExp) => {
  const call = mockReservedUnsafe.mock.calls.find(([sql]) => matcher.test(String(sql)));
  return call ? { sql: String(call[0]), values: (call[1] ?? []) as unknown[] } : null;
};

const expectNothingEmitted = async () => {
  await settle();
  expect(inbox).toEqual({ caller: [], peer: [], removed: [], outsider: [] });
};

describe("DELETE /sharing/member", () => {
  test("is the one route served at DELETE /sharing/member, and takes no API key", async () => {
    const routes = await import("server/routes");
    const served = Object.values(routes).filter(
      (route) =>
        (route as { method?: string }).method === "DELETE" &&
        (route as { path?: string }).path === "/sharing/member",
    );
    expect(served).toEqual([deleteSharingMemberRoute]);
    expect(deleteSharingMemberRoute.requiredScope).toBeUndefined();
  });

  test("rejects unauthenticated requests without touching the database", async () => {
    const result = await deleteSharingMemberRoute.execute(
      makeReq({ user_id: REMOVED.user_id }, { user: null }),
      fakeRes(),
    );
    expect(result).toEqual({ status: "failed", message: "Request user is not authenticated." });
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockReservedUnsafe).not.toHaveBeenCalled();
    await expectNothingEmitted();
  });

  test.each([
    ["a missing user_id", {}, "Missing required parameter: user_id"],
    [
      "a repeated user_id",
      { user_id: [REMOVED.user_id, PEER.user_id] },
      "Parameter user_id must be a single value, not an array",
    ],
    ["a blank user_id", { user_id: "   " }, "Parameter user_id cannot be empty"],
    ["a user_id that is not a UUID", { user_id: "removed" }, "Field user_id must be a uuid"],
    ["an id passed under another name", { id: REMOVED.user_id }, "Missing required parameter: user_id"],
  ])("refuses %s before any SQL", async (_, query, message) => {
    const result = await deleteSharingMemberRoute.execute(makeReq(query), fakeRes());
    expect(result).toEqual({ status: "failed", message });
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockReservedUnsafe).not.toHaveBeenCalled();
    await expectNothingEmitted();
  });

  test("removes the named member from the session user's group", async () => {
    const result = await deleteSharingMemberRoute.execute(makeReq({ user_id: REMOVED.user_id }), fakeRes());

    expect(result).toEqual({ status: "success" });
    expect(inTransaction(GROUP_LOOKUP)!.values).toEqual([CALLER.user_id]);
    expect(inTransaction(MEMBERS_DELETE)!.values).toEqual([[REMOVED.user_id]]);
    const transaction = mockReservedUnsafe.mock.calls.map(([sql]) => String(sql));
    expect(transaction[0]).toBe("BEGIN");
    expect(transaction[transaction.length - 1]).toBe("COMMIT");
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("tells every former member once, the removed one included, echoing the request's tab id", async () => {
    await deleteSharingMemberRoute.execute(
      makeReq({ user_id: REMOVED.user_id }, { headers: { "x-tab-id": "tab-7" } }),
      fakeRes(),
    );
    await settle();

    const event = { event: "sharing_members-updated", payload: { originTabId: "tab-7" } };
    expect(inbox.caller).toEqual([event]);
    expect(inbox.peer).toEqual([event]);
    expect(inbox.removed).toEqual([event]);
    expect(inbox.outsider).toEqual([]);
  });

  test("a request with no tab id emits an empty payload", async () => {
    await deleteSharingMemberRoute.execute(makeReq({ user_id: REMOVED.user_id }), fakeRes());
    await settle();

    const event = { event: "sharing_members-updated", payload: {} };
    expect(inbox.caller).toEqual([event]);
    expect(inbox.peer).toEqual([event]);
    expect(inbox.removed).toEqual([event]);
  });

  test("a caller leaving a group of two dissolves it and tells both", async () => {
    former = [CALLER.user_id, PEER.user_id];

    const result = await deleteSharingMemberRoute.execute(
      makeReq({ user_id: CALLER.user_id }, { headers: { "x-tab-id": "tab-7" } }),
      fakeRes(),
    );
    await settle();

    expect(result).toEqual({ status: "success" });
    expect(inTransaction(MEMBERS_DELETE)!.values).toEqual([[CALLER.user_id, PEER.user_id]]);
    const event = { event: "sharing_members-updated", payload: { originTabId: "tab-7" } };
    expect(inbox.caller).toEqual([event]);
    expect(inbox.peer).toEqual([event]);
    expect(inbox.removed).toEqual([]);
    expect(inbox.outsider).toEqual([]);
  });

  test("passes the refusal for a user outside the caller's group through and emits nothing", async () => {
    const result = await deleteSharingMemberRoute.execute(
      makeReq({ user_id: OUTSIDER.user_id }, { headers: { "x-tab-id": "tab-7" } }),
      fakeRes(),
    );

    expect(result).toEqual({ status: "failed", message: "You don't share data with that user." });
    expect(inTransaction(MEMBERS_DELETE)).toBeNull();
    await expectNothingEmitted();
  });

  test("passes the refusal for a caller who shares with nobody through and emits nothing", async () => {
    former = [CALLER.user_id];

    const result = await deleteSharingMemberRoute.execute(
      makeReq({ user_id: CALLER.user_id }, { headers: { "x-tab-id": "tab-7" } }),
      fakeRes(),
    );

    expect(result).toEqual({ status: "failed", message: "You don't share data with that user." });
    expect(inTransaction(MEMBERS_DELETE)).toBeNull();
    await expectNothingEmitted();
  });
});
