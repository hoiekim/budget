import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";

const { driver, mockUnsafe, mockReservedUnsafe, resetSqlMocks } = createFakeSql();

mock.module("../../lib/postgres/sql-driver", () => driver);

const { postSharingInvitationRoute } = await import("./post-sharing-invitation");
const { registerSubscriber, unregisterSubscriber } = await import("server/lib/realtime");

afterAll(restoreLeaves);

const INVITER = { user_id: "c3000000-0000-4000-8000-000000000001", username: "inviter" };
const PEER = { user_id: "c3000000-0000-4000-8000-000000000002", username: "peer" };
const INVITEE = { user_id: "c3000000-0000-4000-8000-000000000003", username: "invitee" };
const OUTSIDER = { user_id: "c3000000-0000-4000-8000-000000000004", username: "outsider" };
const INVITATION_ID = "c3000000-0000-4000-8000-0000000000aa";

const USER_BY_NAME = /^\s*SELECT \* FROM users WHERE username = \$1/i;
const GROUP_LOOKUP = /SELECT unnest\(sharing_user_ids\(\$1\)\)/i;
const CROSSING_LOOKUP =
  /^\s*SELECT \* FROM sharing_invitations WHERE inviter_user_id = \$1 AND invitee_user_id = \$2 LIMIT \$3\s*$/i;
const INVITATION_READ = /^\s*SELECT \* FROM sharing_invitations\b/i;
const INVITATION_INSERT = /^\s*INSERT INTO sharing_invitations\b/i;

const userRow = (user: { user_id: string; username: string }) => ({
  ...user,
  password: null,
  email: null,
  expiry: null,
  token: null,
  auth_sub: null,
  updated: null,
  is_deleted: false,
});

const invitationRow = (inviter_user_id: string, invitee_user_id: string) => ({
  invitation_id: INVITATION_ID,
  inviter_user_id,
  invitee_user_id,
  updated: null,
});

const db = {
  users: [] as { user_id: string; username: string }[],
  /** Sharing group per user id; a user missing here shares with nobody. */
  groups: {} as Record<string, string[]>,
  /** An open invitation the invitee already sent the caller. */
  crossing: false,
  /** Fail the group lookup from this call on (1 = the first). */
  failGroupLookupFrom: Infinity,
};
let groupLookups = 0;

const queryRouter = async (sql: string, values: unknown[] = []) => {
  if (USER_BY_NAME.test(sql)) {
    const rows = db.users.filter((user) => user.username === values[0]).map(userRow);
    return { rows, rowCount: rows.length };
  }
  if (GROUP_LOOKUP.test(sql)) {
    if (++groupLookups >= db.failGroupLookupFrom) throw new Error("connection lost");
    const id = values[0] as string;
    const rows = (db.groups[id] ?? [id]).map((user_id) => ({ user_id }));
    return { rows, rowCount: rows.length };
  }
  if (CROSSING_LOOKUP.test(sql)) {
    const rows = db.crossing ? [invitationRow(values[0] as string, values[1] as string)] : [];
    return { rows, rowCount: rows.length };
  }
  if (INVITATION_READ.test(sql)) {
    return { rows: [invitationRow(values[0] as string, values[1] as string)], rowCount: 1 };
  }
  if (INVITATION_INSERT.test(sql)) {
    return { rows: [{ invitation_id: INVITATION_ID }], rowCount: 1 };
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

/** The group lookup behind an emit is not awaited by the route; let it resolve. */
const settle = () => Bun.sleep(0);

let inbox: { inviter: Sent[]; peer: Sent[]; invitee: Sent[]; outsider: Sent[] };

beforeEach(() => {
  resetSqlMocks();
  mockUnsafe.mockImplementation(queryRouter);
  db.users = [INVITER, PEER, INVITEE, OUTSIDER];
  db.groups = { [INVITER.user_id]: [INVITER.user_id, PEER.user_id] };
  db.crossing = false;
  db.failGroupLookupFrom = Infinity;
  groupLookups = 0;
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
  const user = opts.user === undefined ? INVITER : opts.user;
  return {
    method: "POST",
    path: "/sharing/invitation",
    url: "http://x/api/sharing/invitation",
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
  } as unknown as Parameters<typeof postSharingInvitationRoute.execute>[0];
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
  }) as unknown as Parameters<typeof postSharingInvitationRoute.execute>[1];

const find = (matcher: RegExp) => {
  const call = mockUnsafe.mock.calls.find(([sql]) => matcher.test(String(sql)));
  return call ? { sql: String(call[0]), values: (call[1] ?? []) as unknown[] } : null;
};

const expectNothingEmitted = async () => {
  await settle();
  expect(inbox).toEqual({ inviter: [], peer: [], invitee: [], outsider: [] });
};

describe("POST /sharing/invitation", () => {
  test("is the one route served at POST /sharing/invitation, and takes no API key", async () => {
    const routes = await import("server/routes");
    const served = Object.values(routes).filter(
      (route) =>
        (route as { method?: string }).method === "POST" &&
        (route as { path?: string }).path === "/sharing/invitation",
    );
    expect(served).toEqual([postSharingInvitationRoute]);
    expect(postSharingInvitationRoute.requiredScope).toBeUndefined();
  });

  test("rejects unauthenticated requests without touching the database", async () => {
    const result = await postSharingInvitationRoute.execute(
      makeReq({ username: INVITEE.username }, { user: null }),
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
    ["an array body", [{ username: "invitee" }], "Request body must be an object"],
    ["a string body", "invitee", "Request body must be an object"],
    ["a body with no username", {}, "Missing required field: username"],
    ["a null username", { username: null }, "Missing required field: username"],
    ["a numeric username", { username: 42 }, "Field username must be a string"],
    ["a username given as a list", { username: ["invitee"] }, "Field username must be a string"],
  ])("refuses %s before any SQL", async (_, body, message) => {
    const result = await postSharingInvitationRoute.execute(makeReq(body), fakeRes());
    expect(result).toEqual({ status: "failed", message });
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockReservedUnsafe).not.toHaveBeenCalled();
    await expectNothingEmitted();
  });

  test("invites the named user and returns the invitation", async () => {
    const result = await postSharingInvitationRoute.execute(makeReq({ username: INVITEE.username }), fakeRes());

    expect(result).toEqual({
      status: "success",
      body: { invitation: { invitation_id: INVITATION_ID, inviter: INVITER, invitee: INVITEE } },
    });
    const insert = find(INVITATION_INSERT);
    expect(insert).not.toBeNull();
    expect(insert!.sql).toMatch(/\(updated, inviter_user_id, invitee_user_id\)/);
    expect(insert!.values).toEqual([INVITER.user_id, INVITEE.user_id]);
    await settle();
  });

  test("trims the username before looking the user up", async () => {
    const result = await postSharingInvitationRoute.execute(makeReq({ username: "  invitee\n" }), fakeRes());

    expect(result?.status).toBe("success");
    expect(find(USER_BY_NAME)!.values[0]).toBe("invitee");
    await settle();
  });

  test("tells the inviter's sharing group and the invitee, echoing the request's tab id", async () => {
    await postSharingInvitationRoute.execute(
      makeReq({ username: INVITEE.username }, { headers: { "x-tab-id": "tab-7" } }),
      fakeRes(),
    );
    await settle();

    const event = { event: "sharing_invitations-updated", payload: { originTabId: "tab-7" } };
    expect(inbox.inviter).toEqual([event]);
    expect(inbox.peer).toEqual([event]);
    expect(inbox.invitee).toEqual([event]);
    expect(inbox.outsider).toEqual([]);
  });

  test("a request with no tab id emits an empty payload", async () => {
    await postSharingInvitationRoute.execute(makeReq({ username: INVITEE.username }), fakeRes());
    await settle();

    const event = { event: "sharing_invitations-updated", payload: {} };
    expect(inbox.inviter).toEqual([event]);
    expect(inbox.peer).toEqual([event]);
    expect(inbox.invitee).toEqual([event]);
  });

  test("an unreadable sharing group still tells the inviter and the invitee", async () => {
    // The first lookup is the repository's membership check; the second is the emit's.
    db.failGroupLookupFrom = 2;

    const result = await postSharingInvitationRoute.execute(
      makeReq({ username: INVITEE.username }, { headers: { "x-tab-id": "tab-7" } }),
      fakeRes(),
    );
    await settle();

    expect(result?.status).toBe("success");
    const event = { event: "sharing_invitations-updated", payload: { originTabId: "tab-7" } };
    expect(inbox.inviter).toEqual([event]);
    expect(inbox.invitee).toEqual([event]);
    expect(inbox.peer).toEqual([]);
  });

  test.each([
    ["an unknown username", { username: "nobody" }, "No user has that username."],
    ["the caller's own username", { username: INVITER.username }, "You can't invite yourself."],
    ["someone already in the caller's group", { username: PEER.username }, "You already share data with peer."],
    ["the demo account", { username: "demo" }, "The demo account can't share data."],
  ])("passes the refusal for %s through and emits nothing", async (_, body, message) => {
    const result = await postSharingInvitationRoute.execute(
      makeReq(body, { headers: { "x-tab-id": "tab-7" } }),
      fakeRes(),
    );

    expect(result).toEqual({ status: "failed", message });
    expect(find(INVITATION_INSERT)).toBeNull();
    await expectNothingEmitted();
  });

  test("passes the refusal for an invitation that crosses an open one through and emits nothing", async () => {
    db.crossing = true;

    const result = await postSharingInvitationRoute.execute(
      makeReq({ username: INVITEE.username }, { headers: { "x-tab-id": "tab-7" } }),
      fakeRes(),
    );

    expect(result).toEqual({
      status: "failed",
      message: "invitee already invited you. Accept that invitation.",
    });
    expect(find(CROSSING_LOOKUP)!.values).toEqual([INVITEE.user_id, INVITER.user_id, 1]);
    expect(find(INVITATION_INSERT)).toBeNull();
    await expectNothingEmitted();
  });

  test("the demo account cannot invite anyone, and no SQL is issued for it", async () => {
    const result = await postSharingInvitationRoute.execute(
      makeReq({ username: INVITEE.username }, { user: { user_id: OUTSIDER.user_id, username: "demo" } }),
      fakeRes(),
    );

    expect(result).toEqual({ status: "failed", message: "The demo account can't share data." });
    expect(mockUnsafe).not.toHaveBeenCalled();
    await expectNothingEmitted();
  });
});
