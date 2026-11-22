import { describe, test, expect, mock, beforeEach, afterEach, afterAll, setSystemTime } from "bun:test";
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
const USER_BY_EMAIL = /^\s*SELECT \* FROM users WHERE lower\(email\) = lower\(\$1\)/i;
const EMAIL_INVITATION_UPSERT = /^\s*INSERT INTO sharing_email_invitations\b/i;
const EMAIL_INVITATION_ID = "c3000000-0000-4000-8000-0000000000bb";

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
  /** The email address each user signed in with, by user id. */
  emails: {} as Record<string, string>,
};
let groupLookups = 0;

const queryRouter = async (sql: string, values: unknown[] = []) => {
  if (USER_BY_NAME.test(sql)) {
    const rows = db.users.filter((user) => user.username === values[0]).map(userRow);
    return { rows, rowCount: rows.length };
  }
  if (USER_BY_EMAIL.test(sql)) {
    const address = String(values[0]).toLowerCase();
    const rows = db.users
      .filter((user) => db.emails[user.user_id]?.toLowerCase() === address)
      .map((user) => ({ ...userRow(user), email: db.emails[user.user_id] }));
    return { rows, rowCount: rows.length };
  }
  if (EMAIL_INVITATION_UPSERT.test(sql)) {
    const [inviter_user_id, invitee_email, expires_at] = values;
    const row = { invitation_id: EMAIL_INVITATION_ID, inviter_user_id, invitee_email, expires_at, updated: null };
    return { rows: [row], rowCount: 1 };
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
  db.emails = {};
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

describe("POST /sharing/invitation { email }", () => {
  const NOW = Date.parse("2026-11-22T10:00:00.000Z");
  const EXPIRES_AT = "2026-12-22T10:00:00.000Z";

  beforeEach(() => setSystemTime(new Date(NOW)));
  afterAll(() => setSystemTime());

  const sentTo = (email: string) => ({
    status: "success",
    body: {
      invitation: {
        invitation_id: EMAIL_INVITATION_ID,
        inviter: INVITER,
        invitee: { email },
        expires_at: EXPIRES_AT,
      },
    },
  });

  test.each([
    ["a null address", { email: null }, "Missing required field: email"],
    ["a numeric address", { email: 42 }, "Field email must be a string"],
    ["an address with no @", { email: "friend.example.com" }, "Field email must be an email address"],
    ["an address with nothing before the @", { email: "@example.com" }, "Field email must be an email address"],
    ["an address with nothing after the @", { email: "friend@" }, "Field email must be an email address"],
    ["an address with a space in it", { email: "a friend@example.com" }, "Field email must be an email address"],
    ["an address with two @", { email: "a@b@example.com" }, "Field email must be an email address"],
    ["a blank address", { email: "   " }, "Field email must be an email address"],
    [
      "an address longer than the column",
      { email: `${"a".repeat(244)}@example.com` },
      "Field email must be at most 255 characters",
    ],
  ])("refuses %s before any SQL", async (_, body, message) => {
    const result = await postSharingInvitationRoute.execute(makeReq(body), fakeRes());
    expect(result).toEqual({ status: "failed", message });
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockReservedUnsafe).not.toHaveBeenCalled();
    await expectNothingEmitted();
  });

  test("an address of 255 characters is long enough to be accepted", async () => {
    const email = `${"a".repeat(243)}@example.com`;
    expect(email).toHaveLength(255);

    const result = await postSharingInvitationRoute.execute(makeReq({ email }), fakeRes());

    expect(result).toEqual(sentTo(email));
    await settle();
  });

  test("invites an address nobody has yet, trimmed and in lower case, open for thirty days", async () => {
    const result = await postSharingInvitationRoute.execute(
      makeReq({ email: "  Friend@Example.com " }),
      fakeRes(),
    );

    expect(result).toEqual(sentTo("friend@example.com"));
    expect(find(USER_BY_EMAIL)!.values).toEqual(["friend@example.com", 1]);
    expect(find(EMAIL_INVITATION_UPSERT)!.values).toEqual([
      INVITER.user_id,
      "friend@example.com",
      EXPIRES_AT,
    ]);
    expect(find(INVITATION_INSERT)).toBeNull();
    await settle();
  });

  test("answers an address someone has exactly as one nobody has", async () => {
    const nobody = await postSharingInvitationRoute.execute(makeReq({ email: "friend@example.com" }), fakeRes());
    db.emails = { [INVITEE.user_id]: "Friend@Example.com" };
    const someone = await postSharingInvitationRoute.execute(makeReq({ email: "friend@example.com" }), fakeRes());

    expect(someone).toEqual(nobody);
    expect(JSON.stringify(someone)).not.toContain(`"username":"${INVITEE.username}"`);
    expect(JSON.stringify(someone)).not.toContain(INVITEE.user_id);
    await settle();
  });

  test("tells the inviter's group, and the user with the address when anyone has it", async () => {
    db.emails = { [INVITEE.user_id]: "friend@example.com" };

    await postSharingInvitationRoute.execute(
      makeReq({ email: "friend@example.com" }, { headers: { "x-tab-id": "tab-7" } }),
      fakeRes(),
    );
    await settle();

    const event = { event: "sharing_invitations-updated", payload: { originTabId: "tab-7" } };
    expect(inbox).toEqual({ inviter: [event], peer: [event], invitee: [event], outsider: [] });
  });

  test("an address nobody has tells the inviter's group alone", async () => {
    await postSharingInvitationRoute.execute(makeReq({ email: "friend@example.com" }), fakeRes());
    await settle();

    const event = { event: "sharing_invitations-updated", payload: {} };
    expect(inbox).toEqual({ inviter: [event], peer: [event], invitee: [], outsider: [] });
  });

  test("an address takes precedence over a username sent with it", async () => {
    const result = await postSharingInvitationRoute.execute(
      makeReq({ email: "friend@example.com", username: INVITEE.username }),
      fakeRes(),
    );

    expect(result).toEqual(sentTo("friend@example.com"));
    expect(find(USER_BY_NAME)).toBeNull();
    await settle();
  });

  test.each([
    ["the caller's own address", INVITER, "You can't invite yourself."],
    ["the address of someone in the caller's group", PEER, "You already share data with peer."],
  ])("passes the refusal for %s through, writes nothing and emits nothing", async (_, holder, message) => {
    db.emails = { [holder.user_id]: "friend@example.com" };

    const result = await postSharingInvitationRoute.execute(
      makeReq({ email: "friend@example.com" }, { headers: { "x-tab-id": "tab-7" } }),
      fakeRes(),
    );

    expect(result).toEqual({ status: "failed", message });
    expect(find(EMAIL_INVITATION_UPSERT)).toBeNull();
    await expectNothingEmitted();
  });

  test("the demo account cannot invite an address, and no SQL is issued for it", async () => {
    const result = await postSharingInvitationRoute.execute(
      makeReq({ email: "friend@example.com" }, { user: { user_id: OUTSIDER.user_id, username: "demo" } }),
      fakeRes(),
    );

    expect(result).toEqual({ status: "failed", message: "The demo account can't share data." });
    expect(mockUnsafe).not.toHaveBeenCalled();
    await expectNothingEmitted();
  });
});
