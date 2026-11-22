import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";

const { driver, mockUnsafe, mockReservedUnsafe, resetSqlMocks } = createFakeSql();

mock.module("../../lib/postgres/sql-driver", () => driver);

const { getSharingRoute } = await import("./get-sharing");

afterAll(restoreLeaves);

const MEMBERS_QUERY = /\bFROM\s+sharing_members\s+m\b/i;
const INVITATIONS_QUERY = /\bFROM\s+sharing_invitations\s+i\b/i;
const EMAIL_INVITATIONS_QUERY = /\bFROM\s+sharing_email_invitations\s+e\b/i;

const CALLER = { user_id: "a1000000-0000-4000-8000-000000000001", username: "caller" };
const PEER = { user_id: "a1000000-0000-4000-8000-000000000002", username: "peer" };
const INVITEE = { user_id: "a1000000-0000-4000-8000-000000000003", username: "invitee" };
const STRANGER = { user_id: "a1000000-0000-4000-8000-000000000004", username: "stranger" };

let memberRows: Record<string, unknown>[] = [];
let invitationRows: Record<string, unknown>[] = [];
let emailInvitationRows: Record<string, unknown>[] = [];

const queryRouter = async (sql: string) => {
  if (INVITATIONS_QUERY.test(sql)) return { rows: invitationRows, rowCount: invitationRows.length };
  if (EMAIL_INVITATIONS_QUERY.test(sql)) {
    return { rows: emailInvitationRows, rowCount: emailInvitationRows.length };
  }
  if (MEMBERS_QUERY.test(sql)) return { rows: memberRows, rowCount: memberRows.length };
  return { rows: [], rowCount: 0 };
};

beforeEach(() => {
  resetSqlMocks();
  mockUnsafe.mockImplementation(queryRouter);
  memberRows = [];
  invitationRows = [];
  emailInvitationRows = [];
});

function makeReq(user: { user_id: string; username: string } | null = CALLER) {
  return {
    method: "GET",
    path: "/sharing",
    url: "http://x/api/sharing",
    headers: {},
    query: {},
    body: undefined,
    session: {
      id: "s-1",
      user: user ?? undefined,
      regenerate() {},
      destroy() {},
    },
    ip: "127.0.0.1",
  } as unknown as Parameters<typeof getSharingRoute.execute>[0];
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
  }) as unknown as Parameters<typeof getSharingRoute.execute>[1];

const statements = () =>
  mockUnsafe.mock.calls.map(([sql, values]) => ({ sql: String(sql), values: (values ?? []) as unknown[] }));

describe("GET /sharing", () => {
  test("is the one route served at GET /sharing, and takes no API key", async () => {
    const routes = await import("server/routes");
    const served = Object.values(routes).filter(
      (route) => (route as { method?: string }).method === "GET" && (route as { path?: string }).path === "/sharing",
    );
    expect(served).toEqual([getSharingRoute]);
    expect(getSharingRoute.requiredScope).toBeUndefined();
  });

  test("rejects unauthenticated requests without touching the database", async () => {
    const result = await getSharingRoute.execute(makeReq(null), fakeRes());
    expect(result).toEqual({ status: "failed", message: "Request user is not authenticated." });
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockReservedUnsafe).not.toHaveBeenCalled();
  });

  test("returns the session user's group members and open invitations", async () => {
    memberRows = [CALLER, PEER];
    invitationRows = [
      {
        invitation_id: "b2000000-0000-4000-8000-000000000001",
        inviter_user_id: PEER.user_id,
        inviter_username: PEER.username,
        invitee_user_id: INVITEE.user_id,
        invitee_username: INVITEE.username,
      },
      {
        invitation_id: "b2000000-0000-4000-8000-000000000002",
        inviter_user_id: STRANGER.user_id,
        inviter_username: STRANGER.username,
        invitee_user_id: CALLER.user_id,
        invitee_username: CALLER.username,
      },
    ];

    const result = await getSharingRoute.execute(makeReq(), fakeRes());

    expect(result).toEqual({
      status: "success",
      body: {
        members: [CALLER, PEER],
        invitations: [
          { invitation_id: "b2000000-0000-4000-8000-000000000001", inviter: PEER, invitee: INVITEE },
          { invitation_id: "b2000000-0000-4000-8000-000000000002", inviter: STRANGER, invitee: CALLER },
        ],
      },
    });
  });

  test("a user who shares with nobody gets two empty lists", async () => {
    const result = await getSharingRoute.execute(makeReq(), fakeRes());
    expect(result).toEqual({ status: "success", body: { members: [], invitations: [] } });
  });

  test("an email invitation shows its address to the group that sent it, and the caller to the caller it reached", async () => {
    emailInvitationRows = [
      {
        invitation_id: "b2000000-0000-4000-8000-000000000003",
        invitee_email: "friend@example.com",
        expires_at: "2026-12-22T00:00:00.000Z",
        inviter_user_id: PEER.user_id,
        inviter_username: PEER.username,
        sent: true,
      },
      {
        invitation_id: "b2000000-0000-4000-8000-000000000004",
        invitee_email: "caller@example.com",
        expires_at: "2026-12-23T00:00:00.000Z",
        inviter_user_id: STRANGER.user_id,
        inviter_username: STRANGER.username,
        sent: false,
      },
    ];

    const result = await getSharingRoute.execute(makeReq(), fakeRes());

    expect(result).toEqual({
      status: "success",
      body: {
        members: [],
        invitations: [
          {
            invitation_id: "b2000000-0000-4000-8000-000000000003",
            inviter: PEER,
            invitee: { email: "friend@example.com" },
            expires_at: "2026-12-22T00:00:00.000Z",
          },
          {
            invitation_id: "b2000000-0000-4000-8000-000000000004",
            inviter: STRANGER,
            invitee: CALLER,
            expires_at: "2026-12-23T00:00:00.000Z",
          },
        ],
      },
    });
  });

  test("every read is bound to the session user and nobody else", async () => {
    await getSharingRoute.execute(makeReq(PEER), fakeRes());

    const issued = statements();
    expect(issued).toHaveLength(3);
    for (const { values } of issued) expect(values).toEqual([PEER.user_id]);

    const members = issued.find(({ sql }) => MEMBERS_QUERY.test(sql))!;
    expect(members.sql).toMatch(/own\.user_id = \$1/);
    const invitations = issued.find(({ sql }) => INVITATIONS_QUERY.test(sql))!;
    expect(invitations.sql).toMatch(
      /i\.invitee_user_id = \$1 OR i\.inviter_user_id = ANY\(sharing_user_ids\(\$1\)\)/,
    );
    const emailInvitations = issued.find(({ sql }) => EMAIL_INVITATIONS_QUERY.test(sql))!;
    expect(emailInvitations.sql).toMatch(
      /e\.inviter_user_id = ANY\(sharing_user_ids\(\$1\)\) OR \(e\.invitee_email = \(SELECT lower\(u\.email\) FROM users u WHERE u\.user_id = \$1\)/,
    );
    expect(mockReservedUnsafe).not.toHaveBeenCalled();
  });
});
