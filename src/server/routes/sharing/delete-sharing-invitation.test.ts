import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";

const { driver, mockUnsafe, mockReservedUnsafe, resetSqlMocks } = createFakeSql();

mock.module("../../lib/postgres/sql-driver", () => driver);

const { deleteSharingInvitationRoute } = await import("./delete-sharing-invitation");
const { registerSubscriber, unregisterSubscriber } = await import("server/lib/realtime");

afterAll(restoreLeaves);

const INVITER = { user_id: "d4000000-0000-4000-8000-000000000001", username: "inviter" };
const INVITER_PEER = { user_id: "d4000000-0000-4000-8000-000000000002", username: "inviter-peer" };
const INVITEE = { user_id: "d4000000-0000-4000-8000-000000000003", username: "invitee" };
const INVITEE_PEER = { user_id: "d4000000-0000-4000-8000-000000000004", username: "invitee-peer" };
const OUTSIDER = { user_id: "d4000000-0000-4000-8000-000000000005", username: "outsider" };
const INVITATION_ID = "d4000000-0000-4000-8000-0000000000aa";

const INVITATION_DELETE = /^\s*DELETE FROM sharing_invitations\b/i;
const EMAIL_INVITATION_DELETE = /^\s*DELETE FROM sharing_email_invitations\b/i;
const GROUP_LOOKUP = /SELECT unnest\(sharing_user_ids\(\$1\)\)/i;

const db = {
  /** The row the DELETE removes and returns, or null when no invitation matches. */
  deleted: null as { inviter_user_id: string; invitee_user_id: string } | null,
  /** The same for an invitation sent to an address, naming the user who has it, if anyone. */
  emailDeleted: null as { inviter_user_id: string; invitee_user_id: string | null } | null,
  groups: {} as Record<string, string[]>,
  failGroupLookups: false,
};

const queryRouter = async (sql: string, values: unknown[] = []) => {
  if (INVITATION_DELETE.test(sql)) {
    return db.deleted ? { rows: [db.deleted], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (EMAIL_INVITATION_DELETE.test(sql)) {
    return db.emailDeleted ? { rows: [db.emailDeleted], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (GROUP_LOOKUP.test(sql)) {
    if (db.failGroupLookups) throw new Error("connection lost");
    const id = values[0] as string;
    const rows = (db.groups[id] ?? [id]).map((user_id) => ({ user_id }));
    return { rows, rowCount: rows.length };
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

let inbox: { inviter: Sent[]; inviterPeer: Sent[]; invitee: Sent[]; inviteePeer: Sent[]; outsider: Sent[] };

beforeEach(() => {
  resetSqlMocks();
  mockUnsafe.mockImplementation(queryRouter);
  db.deleted = { inviter_user_id: INVITER.user_id, invitee_user_id: INVITEE.user_id };
  db.emailDeleted = null;
  db.groups = {
    [INVITER.user_id]: [INVITER.user_id, INVITER_PEER.user_id],
    [INVITEE.user_id]: [INVITEE.user_id, INVITEE_PEER.user_id],
  };
  db.failGroupLookups = false;
  inbox = {
    inviter: listen(INVITER),
    inviterPeer: listen(INVITER_PEER),
    invitee: listen(INVITEE),
    inviteePeer: listen(INVITEE_PEER),
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
  const user = opts.user === undefined ? INVITEE : opts.user;
  return {
    method: "DELETE",
    path: "/sharing/invitation",
    url: "http://x/api/sharing/invitation",
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
  } as unknown as Parameters<typeof deleteSharingInvitationRoute.execute>[0];
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
  }) as unknown as Parameters<typeof deleteSharingInvitationRoute.execute>[1];

const statements = (matcher: RegExp) =>
  mockUnsafe.mock.calls
    .filter(([sql]) => matcher.test(String(sql)))
    .map(([sql, values]) => ({ sql: String(sql), values: (values ?? []) as unknown[] }));

const expectNothingEmitted = async () => {
  await settle();
  expect(inbox).toEqual({ inviter: [], inviterPeer: [], invitee: [], inviteePeer: [], outsider: [] });
};

describe("DELETE /sharing/invitation", () => {
  test("is the one route served at DELETE /sharing/invitation, and takes no API key", async () => {
    const routes = await import("server/routes");
    const served = Object.values(routes).filter(
      (route) =>
        (route as { method?: string }).method === "DELETE" &&
        (route as { path?: string }).path === "/sharing/invitation",
    );
    expect(served).toEqual([deleteSharingInvitationRoute]);
    expect(deleteSharingInvitationRoute.requiredScope).toBeUndefined();
  });

  test("rejects unauthenticated requests without touching the database", async () => {
    const result = await deleteSharingInvitationRoute.execute(
      makeReq({ id: INVITATION_ID }, { user: null }),
      fakeRes(),
    );
    expect(result).toEqual({ status: "failed", message: "Request user is not authenticated." });
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockReservedUnsafe).not.toHaveBeenCalled();
    await expectNothingEmitted();
  });

  test.each([
    ["a missing id", {}, "Missing required parameter: id"],
    ["a repeated id", { id: [INVITATION_ID, INVITATION_ID] }, "Parameter id must be a single value, not an array"],
    ["a blank id", { id: "   " }, "Parameter id cannot be empty"],
    ["an id that is not a UUID", { id: "not-a-uuid" }, "Field id must be a uuid"],
    ["a UUID with trailing text", { id: `${INVITATION_ID}' OR '1'='1` }, "Field id must be a uuid"],
  ])("refuses %s before any SQL", async (_, query, message) => {
    const result = await deleteSharingInvitationRoute.execute(makeReq(query), fakeRes());
    expect(result).toEqual({ status: "failed", message });
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockReservedUnsafe).not.toHaveBeenCalled();
    await expectNothingEmitted();
  });

  test("deletes the invitation as the session user", async () => {
    const result = await deleteSharingInvitationRoute.execute(makeReq({ id: INVITATION_ID }), fakeRes());

    expect(result).toEqual({ status: "success" });
    const deletes = statements(INVITATION_DELETE);
    expect(deletes).toHaveLength(1);
    expect(deletes[0].sql).toMatch(
      /i\.invitation_id = \$2 AND \(i\.invitee_user_id = \$1 OR i\.inviter_user_id = ANY\(sharing_user_ids\(\$1\)\)\)/,
    );
    expect(deletes[0].values).toEqual([INVITEE.user_id, INVITATION_ID]);
    await settle();
  });

  test("tells both people the invitation was between, each with their sharing group", async () => {
    await deleteSharingInvitationRoute.execute(
      makeReq({ id: INVITATION_ID }, { headers: { "x-tab-id": "tab-7" } }),
      fakeRes(),
    );
    await settle();

    const event = { event: "sharing_invitations-updated", payload: { originTabId: "tab-7" } };
    expect(inbox.inviter).toEqual([event]);
    expect(inbox.inviterPeer).toEqual([event]);
    expect(inbox.invitee).toEqual([event]);
    expect(inbox.inviteePeer).toEqual([event]);
    expect(inbox.outsider).toEqual([]);

    expect(statements(GROUP_LOOKUP).map(({ values }) => values)).toEqual([
      [INVITER.user_id],
      [INVITEE.user_id],
    ]);
  });

  test("someone in the inviter's group withdrawing it reaches the same people", async () => {
    await deleteSharingInvitationRoute.execute(makeReq({ id: INVITATION_ID }, { user: INVITER_PEER }), fakeRes());
    await settle();

    const event = { event: "sharing_invitations-updated", payload: {} };
    expect(statements(INVITATION_DELETE)[0].values).toEqual([INVITER_PEER.user_id, INVITATION_ID]);
    expect(inbox.inviter).toEqual([event]);
    expect(inbox.inviterPeer).toEqual([event]);
    expect(inbox.invitee).toEqual([event]);
    expect(inbox.inviteePeer).toEqual([event]);
    expect(inbox.outsider).toEqual([]);
  });

  test("an unreadable sharing group still tells the two people themselves", async () => {
    db.failGroupLookups = true;

    const result = await deleteSharingInvitationRoute.execute(
      makeReq({ id: INVITATION_ID }, { headers: { "x-tab-id": "tab-7" } }),
      fakeRes(),
    );
    await settle();

    expect(result).toEqual({ status: "success" });
    const event = { event: "sharing_invitations-updated", payload: { originTabId: "tab-7" } };
    expect(inbox.inviter).toEqual([event]);
    expect(inbox.invitee).toEqual([event]);
    expect(inbox.inviterPeer).toEqual([]);
    expect(inbox.inviteePeer).toEqual([]);
  });


  test("an invitation sent to an address is deleted when no invitation to a user matches, with the same scope", async () => {
    db.deleted = null;
    db.emailDeleted = { inviter_user_id: INVITER.user_id, invitee_user_id: INVITEE.user_id };

    const result = await deleteSharingInvitationRoute.execute(makeReq({ id: INVITATION_ID }), fakeRes());

    expect(result).toEqual({ status: "success" });
    const deletes = statements(EMAIL_INVITATION_DELETE);
    expect(deletes).toHaveLength(1);
    expect(deletes[0].sql).toMatch(/e\.invitation_id = \$2 AND \(e\.inviter_user_id = ANY\(sharing_user_ids\(\$1\)\) OR /);
    expect(deletes[0].values).toEqual([INVITEE.user_id, INVITATION_ID]);
    await settle();
  });

  test("an invitation sent to an address someone has tells the inviter's group and that user's", async () => {
    db.deleted = null;
    db.emailDeleted = { inviter_user_id: INVITER.user_id, invitee_user_id: INVITEE.user_id };

    await deleteSharingInvitationRoute.execute(makeReq({ id: INVITATION_ID }, { user: INVITER }), fakeRes());
    await settle();

    const event = { event: "sharing_invitations-updated", payload: {} };
    expect(inbox).toEqual({
      inviter: [event],
      inviterPeer: [event],
      invitee: [event],
      inviteePeer: [event],
      outsider: [],
    });
  });

  test("an invitation sent to an address nobody has tells the inviter's group alone", async () => {
    db.deleted = null;
    db.emailDeleted = { inviter_user_id: INVITER.user_id, invitee_user_id: null };

    await deleteSharingInvitationRoute.execute(makeReq({ id: INVITATION_ID }, { user: INVITER }), fakeRes());
    await settle();

    const event = { event: "sharing_invitations-updated", payload: {} };
    expect(inbox).toEqual({ inviter: [event], inviterPeer: [event], invitee: [], inviteePeer: [], outsider: [] });
  });
  test("answers 'no longer open' and emits nothing when no invitation was deleted", async () => {
    db.deleted = null;

    const result = await deleteSharingInvitationRoute.execute(
      makeReq({ id: INVITATION_ID }, { headers: { "x-tab-id": "tab-7" } }),
      fakeRes(),
    );

    expect(result).toEqual({ status: "failed", message: "That invitation is no longer open." });
    expect(statements(INVITATION_DELETE)).toHaveLength(1);
    expect(statements(EMAIL_INVITATION_DELETE)).toHaveLength(1);
    await expectNothingEmitted();
    expect(statements(GROUP_LOOKUP)).toEqual([]);
  });
});
