import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";

const { driver, mockUnsafe, mockReservedUnsafe, resetSqlMocks } = createFakeSql();

mock.module("../../lib/postgres/sql-driver", () => driver);

const { postSharingMemberRoute } = await import("./post-sharing-member");
const { registerSubscriber, unregisterSubscriber } = await import("server/lib/realtime");

afterAll(restoreLeaves);

const INVITER = { user_id: "e5000000-0000-4000-8000-000000000001", username: "inviter" };
const PEER = { user_id: "e5000000-0000-4000-8000-000000000002", username: "peer" };
const INVITEE = { user_id: "e5000000-0000-4000-8000-000000000003", username: "invitee" };
const OUTSIDER = { user_id: "e5000000-0000-4000-8000-000000000004", username: "outsider" };
const INVITATION_ID = "e5000000-0000-4000-8000-0000000000aa";
const INVITER_GROUP = "e5000000-0000-4000-8000-0000000000bb";

const INVITATION_LOOKUP = /^\s*SELECT inviter_user_id FROM sharing_invitations\b/i;
const MEMBERSHIPS_LOOKUP = /^\s*SELECT \* FROM sharing_members\b/i;
const MEMBERS_INSERT = /^\s*INSERT INTO sharing_members\b/i;
const GROUP_LOOKUP = /SELECT unnest\(sharing_user_ids\(\$1\)\)/i;

const db = {
  /** Who sent the invitation being accepted, or null when it is not open to the caller. */
  inviter: null as string | null,
  /** Existing sharing_members rows among the two people. */
  memberships: [] as { user_id: string; group_id: string; updated: null }[],
  /** The caller's sharing group once the transaction's writes are in. */
  groupAfter: [] as string[],
};

const transactionRouter = async (sql: string) => {
  if (INVITATION_LOOKUP.test(sql)) {
    return db.inviter ? { rows: [{ inviter_user_id: db.inviter }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (MEMBERSHIPS_LOOKUP.test(sql)) return { rows: db.memberships, rowCount: db.memberships.length };
  if (GROUP_LOOKUP.test(sql)) {
    return { rows: db.groupAfter.map((user_id) => ({ user_id })), rowCount: db.groupAfter.length };
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

let inbox: { inviter: Sent[]; peer: Sent[]; invitee: Sent[]; outsider: Sent[] };

beforeEach(() => {
  resetSqlMocks();
  mockReservedUnsafe.mockImplementation(transactionRouter);
  db.inviter = INVITER.user_id;
  db.memberships = [
    { user_id: INVITER.user_id, group_id: INVITER_GROUP, updated: null },
  ];
  db.groupAfter = [INVITER.user_id, PEER.user_id, INVITEE.user_id];
  inbox = {
    inviter: listen(INVITER),
    peer: listen(PEER),
    invitee: listen(INVITEE),
    outsider: listen(OUTSIDER),
  };
});

afterEach(() => {
  for (const [userId, subscriber] of subscriptions.splice(0)) unregisterSubscriber(userId, subscriber);
});

function makeReq(
  body: unknown,
  opts: { user?: { user_id: string; username: string } | null; headers?: Record<string, string | string[]> } = {},
) {
  const user = opts.user === undefined ? INVITEE : opts.user;
  return {
    method: "POST",
    path: "/sharing/member",
    url: "http://x/api/sharing/member",
    headers: opts.headers ?? {},
    query: {},
    body,
    session: {
      id: "s-1",
      user: user ?? undefined,
      regenerate() {},
      destroy() {},
    },
    ip: "127.0.0.1",
  } as unknown as Parameters<typeof postSharingMemberRoute.execute>[0];
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
  }) as unknown as Parameters<typeof postSharingMemberRoute.execute>[1];

const inTransaction = (matcher: RegExp) => {
  const call = mockReservedUnsafe.mock.calls.find(([sql]) => matcher.test(String(sql)));
  return call ? { sql: String(call[0]), values: (call[1] ?? []) as unknown[] } : null;
};

const expectNothingEmitted = async () => {
  await settle();
  expect(inbox).toEqual({ inviter: [], peer: [], invitee: [], outsider: [] });
};

describe("POST /sharing/member", () => {
  test("is the one route served at POST /sharing/member, and takes no API key", async () => {
    const routes = await import("server/routes");
    const served = Object.values(routes).filter(
      (route) =>
        (route as { method?: string }).method === "POST" &&
        (route as { path?: string }).path === "/sharing/member",
    );
    expect(served).toEqual([postSharingMemberRoute]);
    expect(postSharingMemberRoute.requiredScope).toBeUndefined();
  });

  test("rejects unauthenticated requests without touching the database", async () => {
    const result = await postSharingMemberRoute.execute(
      makeReq({ invitation_id: INVITATION_ID }, { user: null }),
      fakeRes(),
    );
    expect(result).toEqual({ status: "failed", message: "Request user is not authenticated." });
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockReservedUnsafe).not.toHaveBeenCalled();
    await expectNothingEmitted();
  });

  test.each([
    ["a missing body", undefined, "Request body is required"],
    ["a null body", null, "Request body is required"],
    ["an array body", [{ invitation_id: INVITATION_ID }], "Request body must be an object"],
    ["a string body", INVITATION_ID, "Request body must be an object"],
    ["a body with no invitation_id", {}, "Missing required field: invitation_id"],
    ["a null invitation_id", { invitation_id: null }, "Missing required field: invitation_id"],
    ["a numeric invitation_id", { invitation_id: 42 }, "Field invitation_id must be a string"],
    ["an invitation_id given as a list", { invitation_id: [INVITATION_ID] }, "Field invitation_id must be a string"],
    ["an invitation_id that is not a UUID", { invitation_id: "not-a-uuid" }, "Field invitation_id must be a uuid"],
    ["an empty invitation_id", { invitation_id: "" }, "Field invitation_id must be a uuid"],
  ])("refuses %s before any SQL", async (_, body, message) => {
    const result = await postSharingMemberRoute.execute(makeReq(body), fakeRes());
    expect(result).toEqual({ status: "failed", message });
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockReservedUnsafe).not.toHaveBeenCalled();
    await expectNothingEmitted();
  });

  test("accepts the invitation as the session user, who joins the inviter's group", async () => {
    const result = await postSharingMemberRoute.execute(makeReq({ invitation_id: INVITATION_ID }), fakeRes());

    expect(result).toEqual({ status: "success" });
    expect(inTransaction(INVITATION_LOOKUP)!.values).toEqual([INVITATION_ID, INVITEE.user_id]);
    const insert = inTransaction(MEMBERS_INSERT);
    expect(insert).not.toBeNull();
    expect(insert!.sql).toMatch(/\(updated, user_id, group_id\)/);
    expect(insert!.values).toEqual([INVITER.user_id, INVITER_GROUP, INVITEE.user_id, INVITER_GROUP]);
    const transaction = mockReservedUnsafe.mock.calls.map(([sql]) => String(sql));
    expect(transaction[0]).toBe("BEGIN");
    expect(transaction[transaction.length - 1]).toBe("COMMIT");
    // The membership change is one transaction; nothing is written outside it.
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("tells every member of the joined group once, echoing the request's tab id", async () => {
    await postSharingMemberRoute.execute(
      makeReq({ invitation_id: INVITATION_ID }, { headers: { "x-tab-id": "tab-7" } }),
      fakeRes(),
    );
    await settle();

    const event = { event: "sharing_members-updated", payload: { originTabId: "tab-7" } };
    expect(inbox.inviter).toEqual([event]);
    expect(inbox.peer).toEqual([event]);
    expect(inbox.invitee).toEqual([event]);
    expect(inbox.outsider).toEqual([]);
  });

  test("a request with no tab id emits an empty payload", async () => {
    await postSharingMemberRoute.execute(makeReq({ invitation_id: INVITATION_ID }), fakeRes());
    await settle();

    const event = { event: "sharing_members-updated", payload: {} };
    expect(inbox.inviter).toEqual([event]);
    expect(inbox.peer).toEqual([event]);
    expect(inbox.invitee).toEqual([event]);
  });

  test("the group it tells is read for the session user inside the transaction", async () => {
    await postSharingMemberRoute.execute(makeReq({ invitation_id: INVITATION_ID }), fakeRes());

    expect(inTransaction(GROUP_LOOKUP)!.values).toEqual([INVITEE.user_id]);
  });

  test("passes the refusal for an invitation that is not open to the caller through", async () => {
    db.inviter = null;

    const result = await postSharingMemberRoute.execute(
      makeReq({ invitation_id: INVITATION_ID }, { headers: { "x-tab-id": "tab-7" } }),
      fakeRes(),
    );

    expect(result).toEqual({ status: "failed", message: "That invitation is no longer open." });
    expect(inTransaction(MEMBERS_INSERT)).toBeNull();
    await expectNothingEmitted();
  });

  test("passes the refusal for a caller who already shares with a group through", async () => {
    db.memberships = [
      { user_id: INVITER.user_id, group_id: INVITER_GROUP, updated: null },
      { user_id: INVITEE.user_id, group_id: "e5000000-0000-4000-8000-0000000000cc", updated: null },
    ];

    const result = await postSharingMemberRoute.execute(
      makeReq({ invitation_id: INVITATION_ID }, { headers: { "x-tab-id": "tab-7" } }),
      fakeRes(),
    );

    expect(result).toEqual({
      status: "failed",
      message: "Stop sharing with your current group before joining another.",
    });
    expect(inTransaction(MEMBERS_INSERT)).toBeNull();
    await expectNothingEmitted();
  });

  test("the demo account cannot accept, and no SQL is issued for it", async () => {
    const result = await postSharingMemberRoute.execute(
      makeReq({ invitation_id: INVITATION_ID }, { user: { user_id: INVITEE.user_id, username: "demo" } }),
      fakeRes(),
    );

    expect(result).toEqual({ status: "failed", message: "The demo account can't share data." });
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockReservedUnsafe).not.toHaveBeenCalled();
    await expectNothingEmitted();
  });
});
