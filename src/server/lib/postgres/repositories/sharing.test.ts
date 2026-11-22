import { describe, test, expect, mock, beforeEach, afterAll, setSystemTime } from "bun:test";
import { createFakeSql, restoreLeaves, type FakeQueryResult } from "test-helpers";

const { driver, mockUnsafe, mockReservedUnsafe, mockReserve, mockRelease, resetSqlMocks } =
  createFakeSql();

mock.module("../sql-driver", () => driver);

const { pool } = await import("../client");
const { accountsTable, itemsTable, transactionsTable, recurringsTable, apiKeysTable } =
  await import("../models");
const {
  getSharingUserIds,
  getSharing,
  getRowOwner,
  inviteToShare,
  inviteByEmail,
  deleteSharingInvitation,
  acceptSharingInvitation,
  removeSharingMember,
  EMAIL_INVITATION_LIFETIME_MS,
  EMAIL_INVITATIONS_PER_USER,
} = await import("./sharing");

afterAll(restoreLeaves);

beforeEach(resetSqlMocks);

const alice = { user_id: "u-alice", username: "alice" };
const bob = { user_id: "u-bob", username: "bob" };
const carol = { user_id: "u-carol", username: "carol" };
const dave = { user_id: "u-dave", username: "dave" };
const demo = { user_id: "u-demo", username: "demo" };

const DEMO_REFUSAL = { ok: false, error: "The demo account can't share data." } as const;

const answer = (rows: unknown[] = []): FakeQueryResult => ({ rows, rowCount: rows.length });

const ids = (...users: { user_id: string }[]) => users.map(({ user_id }) => ({ user_id }));

/** A users row as the database returns it, password included. */
const userRow = (user: { user_id: string; username: string }) => ({
  ...user,
  password: "hashed",
  email: null,
  expiry: null,
  token: null,
  auth_sub: null,
  updated: "2026-05-19T00:00:00.000Z",
  is_deleted: false,
});

const invitationRow = (invitation_id: string, inviter: string, invitee: string) => ({
  invitation_id,
  inviter_user_id: inviter,
  invitee_user_id: invitee,
  updated: "2026-05-19T00:00:00.000Z",
});

const memberRow = (user_id: string, group_id: string) => ({
  user_id,
  group_id,
  updated: "2026-05-19T00:00:00.000Z",
});

type SqlMock = typeof mockUnsafe;

/** Every statement a connection ran, in order, whitespace collapsed, with what it bound. */
const statements = (connection: SqlMock): Array<[string, unknown[]]> =>
  connection.mock.calls.map(([sql, values]) => [sql.replace(/\s+/g, " ").trim(), values ?? []]);

const queue = (connection: SqlMock, ...results: FakeQueryResult[]) => {
  for (const result of results) connection.mockResolvedValueOnce(result);
};

/** Answers for a transaction's statements, after its BEGIN and its advisory lock. */
const queueTransaction = (...results: FakeQueryResult[]) =>
  queue(mockReservedUnsafe, answer(), answer(), ...results);

const BEGIN: [string, unknown[]] = ["BEGIN", []];
const COMMIT: [string, unknown[]] = ["COMMIT", []];
const LOCK: [string, unknown[]] = ["SELECT pg_advisory_xact_lock(hashtext('sharing'))", []];

const SELECT_GROUP = "SELECT unnest(sharing_user_ids($1)) AS user_id";

// An invitation concerns a user it was sent to, or whose group sent it.
const CONCERNS_USER =
  "(i.invitee_user_id = $1 OR i.inviter_user_id = ANY(sharing_user_ids($1)))";

// An email invitation concerns the group that sent it, lapsed or not, and the
// user whose address it was sent to while it is open.
const EMAIL_FROM_GROUP = "e.inviter_user_id = ANY(sharing_user_ids($1))";
const openTo = (param: string) =>
  `(e.invitee_email = (SELECT lower(u.email) FROM users u WHERE u.user_id = ${param})` +
  " AND e.expires_at > CURRENT_TIMESTAMP)";
const EMAIL_CONCERNS_USER = `(${EMAIL_FROM_GROUP} OR ${openTo("$1")})`;

describe("getSharingUserIds", () => {
  test("asks the pool for the user's group and answers the ids in the order returned", async () => {
    queue(mockUnsafe, answer(ids(bob, alice)));

    expect(await getSharingUserIds("u-alice")).toEqual(["u-bob", "u-alice"]);

    expect(statements(mockUnsafe)).toEqual([[SELECT_GROUP, ["u-alice"]]]);
    expect(mockReservedUnsafe).not.toHaveBeenCalled();
  });

  test("runs on a client passed to it, not the pool", async () => {
    const client = await pool.connect();
    queue(mockReservedUnsafe, answer(ids(alice)));

    expect(await getSharingUserIds("u-alice", client)).toEqual(["u-alice"]);

    expect(statements(mockReservedUnsafe)).toEqual([[SELECT_GROUP, ["u-alice"]]]);
    expect(mockUnsafe).not.toHaveBeenCalled();
  });
});

describe("getSharing", () => {
  const SELECT_MEMBERS =
    "SELECT u.user_id, u.username FROM sharing_members m" +
    " JOIN users u ON u.user_id = m.user_id" +
    " WHERE m.group_id = ( SELECT own.group_id FROM sharing_members own WHERE own.user_id = $1 )" +
    " ORDER BY u.username";
  const SELECT_INVITATIONS =
    "SELECT i.invitation_id," +
    " inviter.user_id AS inviter_user_id, inviter.username AS inviter_username," +
    " invitee.user_id AS invitee_user_id, invitee.username AS invitee_username" +
    " FROM sharing_invitations i" +
    " JOIN users inviter ON inviter.user_id = i.inviter_user_id" +
    " JOIN users invitee ON invitee.user_id = i.invitee_user_id" +
    ` WHERE ${CONCERNS_USER}` +
    " ORDER BY invitee.username, i.invitation_id";
  const SELECT_EMAIL_INVITATIONS =
    "SELECT e.invitation_id, e.invitee_email, e.expires_at," +
    " inviter.user_id AS inviter_user_id, inviter.username AS inviter_username," +
    ` ${EMAIL_FROM_GROUP} AS sent` +
    " FROM sharing_email_invitations e" +
    " JOIN users inviter ON inviter.user_id = e.inviter_user_id" +
    ` WHERE ${EMAIL_CONCERNS_USER}` +
    " ORDER BY e.invitee_email, e.invitation_id";

  // The reads start together, so each is answered by what it selects from.
  const answerReads = (members: unknown[], invitations: unknown[], emailInvitations: unknown[] = []) =>
    mockUnsafe.mockImplementation(async (sql: string) => {
      if (/FROM sharing_members m\b/.test(sql)) return answer(members);
      if (/FROM sharing_invitations i\b/.test(sql)) return answer(invitations);
      if (/FROM sharing_email_invitations e\b/.test(sql)) return answer(emailInvitations);
      throw new Error(`unexpected statement: ${sql}`);
    });

  const emailRow = (invitation_id: string, inviter: typeof alice, sent: boolean) => ({
    invitation_id,
    invitee_email: "friend@example.com",
    expires_at: "2026-12-22T00:00:00.000Z",
    inviter_user_id: inviter.user_id,
    inviter_username: inviter.username,
    sent,
  });

  test("answers the group's members and the invitations that concern the user", async () => {
    answerReads(
      [alice, bob],
      [
        {
          invitation_id: "inv-out",
          inviter_user_id: "u-bob",
          inviter_username: "bob",
          invitee_user_id: "u-carol",
          invitee_username: "carol",
        },
        {
          invitation_id: "inv-in",
          inviter_user_id: "u-dave",
          inviter_username: "dave",
          invitee_user_id: "u-alice",
          invitee_username: "alice",
        },
      ],
    );

    expect(await getSharing(alice)).toEqual({
      members: [alice, bob],
      invitations: [
        { invitation_id: "inv-out", inviter: bob, invitee: carol },
        { invitation_id: "inv-in", inviter: dave, invitee: alice },
      ],
    });
  });

  test("reads the members of the user's own group, and invitations sent to the user or by anyone in that group", async () => {
    answerReads([], []);

    await getSharing(alice);

    const ran = statements(mockUnsafe);
    expect(ran).toHaveLength(3);
    expect(ran).toContainEqual([SELECT_MEMBERS, ["u-alice"]]);
    expect(ran).toContainEqual([SELECT_INVITATIONS, ["u-alice"]]);
    expect(ran).toContainEqual([SELECT_EMAIL_INVITATIONS, ["u-alice"]]);
    expect(mockReservedUnsafe).not.toHaveBeenCalled();
  });

  test("names the address of an email invitation the group sent, and the user reading one sent to their address", async () => {
    answerReads(
      [alice, bob],
      [],
      [emailRow("inv-sent", bob, true), emailRow("inv-received", dave, false)],
    );

    expect(await getSharing(alice)).toEqual({
      members: [alice, bob],
      invitations: [
        {
          invitation_id: "inv-sent",
          inviter: bob,
          invitee: { email: "friend@example.com" },
          expires_at: "2026-12-22T00:00:00.000Z",
        },
        {
          invitation_id: "inv-received",
          inviter: dave,
          invitee: alice,
          expires_at: "2026-12-22T00:00:00.000Z",
        },
      ],
    });
  });

  test("lists invitations to users before invitations to addresses", async () => {
    answerReads(
      [],
      [
        {
          invitation_id: "inv-user",
          inviter_user_id: "u-alice",
          inviter_username: "alice",
          invitee_user_id: "u-carol",
          invitee_username: "carol",
        },
      ],
      [emailRow("inv-email", alice, true)],
    );

    const { invitations } = await getSharing(alice);

    expect(invitations.map(({ invitation_id }) => invitation_id)).toEqual(["inv-user", "inv-email"]);
  });

  test("answers empty lists for a user who shares with nobody and has no invitation", async () => {
    answerReads([], []);

    expect(await getSharing(alice)).toEqual({ members: [], invitations: [] });
  });
});

describe("getRowOwner", () => {
  const selectOwner = (table: string, key: string, live: boolean) =>
    `SELECT u.user_id, u.username FROM ${table} r JOIN users u ON u.user_id = r.user_id` +
    ` WHERE r.${key} = $1 AND r.user_id = ANY(sharing_user_ids($2))` +
    (live ? " AND (r.is_deleted IS NULL OR r.is_deleted = FALSE)" : "");

  test("answers the owner of a row that belongs to someone in the user's group", async () => {
    queue(mockUnsafe, answer([bob]));

    expect(await getRowOwner(alice, accountsTable, "acc-1")).toEqual(bob);

    expect(statements(mockUnsafe)).toEqual([
      [selectOwner("accounts", "account_id", true), ["acc-1", "u-alice"]],
    ]);
    expect(mockReservedUnsafe).not.toHaveBeenCalled();
  });

  test.each([
    ["accounts", "account_id", accountsTable],
    ["items", "item_id", itemsTable],
    ["transactions", "transaction_id", transactionsTable],
    ["recurrings", "recurring_id", recurringsTable],
  ] as const)(
    "%s: matches the row by %s, among the group's live rows only",
    async (name, key, table) => {
      await getRowOwner(alice, table, "row-1");

      expect(statements(mockUnsafe)).toEqual([
        [selectOwner(name, key, true), ["row-1", "u-alice"]],
      ]);
    },
  );

  test("a table without soft delete gets no is_deleted predicate, and the statement ends at the group scope", async () => {
    expect(apiKeysTable.supportsSoftDelete).toBe(false);

    await getRowOwner(alice, apiKeysTable, "key-1");

    expect(statements(mockUnsafe)).toEqual([
      [selectOwner("api_keys", "key_id", false), ["key-1", "u-alice"]],
    ]);
  });

  test("answers undefined when no row matches: missing, deleted, or outside the group", async () => {
    queue(mockUnsafe, answer());

    expect(await getRowOwner(alice, accountsTable, "acc-1")).toBeUndefined();
  });
});

describe("inviteToShare", () => {
  const FIND_USER =
    "SELECT * FROM users WHERE username = $1 AND (is_deleted IS NULL OR is_deleted = FALSE) LIMIT $2";
  const FIND_CROSSING =
    "SELECT * FROM sharing_invitations WHERE inviter_user_id = $1 AND invitee_user_id = $2 LIMIT $3";
  const INSERT_INVITATION =
    "INSERT INTO sharing_invitations (updated, inviter_user_id, invitee_user_id)" +
    " VALUES (CURRENT_TIMESTAMP, $1, $2) ON CONFLICT DO NOTHING RETURNING invitation_id";
  const READ_INVITATION =
    "SELECT * FROM sharing_invitations WHERE inviter_user_id = $1 AND invitee_user_id = $2";

  const lookups: Array<[string, unknown[]]> = [
    [FIND_USER, ["bob", 1]],
    [SELECT_GROUP, ["u-alice"]],
    [FIND_CROSSING, ["u-bob", "u-alice", 1]],
  ];
  const writeAndReadBack: Array<[string, unknown[]]> = [
    [INSERT_INVITATION, ["u-alice", "u-bob"]],
    [READ_INVITATION, ["u-alice", "u-bob"]],
  ];

  test("the demo account can't invite, and no statement runs", async () => {
    expect(await inviteToShare(demo, "bob")).toEqual(DEMO_REFUSAL);

    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockReservedUnsafe).not.toHaveBeenCalled();
  });

  test("the demo account can't be invited, and no statement runs", async () => {
    expect(await inviteToShare(alice, "demo")).toEqual(DEMO_REFUSAL);

    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockReservedUnsafe).not.toHaveBeenCalled();
  });

  test("refuses a username no user has, after looking it up", async () => {
    queue(mockUnsafe, answer());

    expect(await inviteToShare(alice, "nobody")).toEqual({
      ok: false,
      error: "No user has that username.",
    });

    expect(statements(mockUnsafe)).toEqual([[FIND_USER, ["nobody", 1]]]);
  });

  test("refuses inviting oneself before reading the group", async () => {
    queue(mockUnsafe, answer([userRow(alice)]));

    expect(await inviteToShare(alice, "alice")).toEqual({
      ok: false,
      error: "You can't invite yourself.",
    });

    expect(statements(mockUnsafe)).toEqual([[FIND_USER, ["alice", 1]]]);
  });

  test("refuses someone already in the user's group, and writes nothing", async () => {
    queue(mockUnsafe, answer([userRow(bob)]), answer(ids(bob, alice)));

    expect(await inviteToShare(alice, "bob")).toEqual({
      ok: false,
      error: "You already share data with bob.",
    });

    expect(statements(mockUnsafe)).toEqual(lookups.slice(0, 2));
  });

  test("refuses when the invitee already invited the user, and writes nothing", async () => {
    queue(
      mockUnsafe,
      answer([userRow(bob)]),
      answer(ids(alice)),
      answer([invitationRow("inv-crossing", "u-bob", "u-alice")]),
    );

    expect(await inviteToShare(alice, "bob")).toEqual({
      ok: false,
      error: "bob already invited you. Accept that invitation.",
    });

    expect(statements(mockUnsafe)).toEqual(lookups);
  });

  test("inserts the invitation, reads it back, and answers it with both usernames", async () => {
    queue(
      mockUnsafe,
      answer([userRow(bob)]),
      answer(ids(alice)),
      answer(),
      answer([{ invitation_id: "inv-1" }]),
      answer([invitationRow("inv-1", "u-alice", "u-bob")]),
    );

    expect(await inviteToShare(alice, "bob")).toEqual({
      ok: true,
      invitation: { invitation_id: "inv-1", inviter: alice, invitee: bob },
    });

    expect(statements(mockUnsafe)).toEqual([...lookups, ...writeAndReadBack]);
    expect(mockReservedUnsafe).not.toHaveBeenCalled();
  });

  test("a member of a group can invite someone outside it", async () => {
    queue(
      mockUnsafe,
      answer([userRow(bob)]),
      answer(ids(carol, alice)),
      answer(),
      answer([{ invitation_id: "inv-1" }]),
      answer([invitationRow("inv-1", "u-alice", "u-bob")]),
    );

    expect(await inviteToShare(alice, "bob")).toEqual({
      ok: true,
      invitation: { invitation_id: "inv-1", inviter: alice, invitee: bob },
    });
  });

  test("inviting someone twice answers the invitation that is already open", async () => {
    queue(
      mockUnsafe,
      answer([userRow(bob)]),
      answer(ids(alice)),
      answer(),
      // The insert conflicts with the open invitation and writes no row.
      answer(),
      answer([invitationRow("inv-open", "u-alice", "u-bob")]),
    );

    expect(await inviteToShare(alice, "bob")).toEqual({
      ok: true,
      invitation: { invitation_id: "inv-open", inviter: alice, invitee: bob },
    });

    expect(statements(mockUnsafe)).toEqual([...lookups, ...writeAndReadBack]);
  });

  test("throws when the invitation is gone by the time it is read back", async () => {
    queue(mockUnsafe, answer([userRow(bob)]), answer(ids(alice)), answer(), answer(), answer());

    await expect(inviteToShare(alice, "bob")).rejects.toThrow(
      "The invitation was withdrawn while it was being sent.",
    );

    expect(statements(mockUnsafe)).toEqual([...lookups, ...writeAndReadBack]);
  });
});

describe("inviteByEmail", () => {
  const FIND_HOLDER =
    "SELECT * FROM users WHERE lower(email) = lower($1) AND (is_deleted IS NULL OR is_deleted = FALSE) LIMIT $2";
  const LOCK_SENDER = "SELECT pg_advisory_xact_lock(hashtext($1 || ':email-invitations'))";
  const SELECT_SENT = "SELECT * FROM sharing_email_invitations WHERE inviter_user_id = $1";
  const UPSERT_INVITATION =
    "INSERT INTO sharing_email_invitations (updated, inviter_user_id, invitee_email, expires_at)" +
    " VALUES (CURRENT_TIMESTAMP, $1, $2, $3)" +
    " ON CONFLICT (inviter_user_id, invitee_email)" +
    " DO UPDATE SET expires_at = EXCLUDED.expires_at, updated = CURRENT_TIMESTAMP RETURNING *";

  const NOW = Date.parse("2026-11-22T10:00:00.000Z");
  const EXPIRES_AT = "2026-12-22T10:00:00.000Z";

  beforeEach(() => setSystemTime(new Date(NOW)));
  afterAll(() => setSystemTime());

  const emailInvitationRow = (
    invitation_id: string,
    invitee_email = "friend@example.com",
    expires_at = EXPIRES_AT,
  ) => ({
    invitation_id,
    inviter_user_id: "u-alice",
    invitee_email,
    expires_at,
    updated: "2026-11-22T10:00:00.000Z",
  });

  /** `count` invitations alice already sent, none of them to friend@example.com. */
  const sentElsewhere = (count: number) =>
    Array.from({ length: count }, (_, i) => emailInvitationRow(`inv-${i}`, `other${i}@example.com`));

  const holderRow = (user: typeof bob, email: string) => ({ ...userRow(user), email });

  // The two reads start together, so each is answered by what it selects from.
  const answerLookups = (holder: unknown[], group: { user_id: string }[]) =>
    mockUnsafe.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT * FROM users")) return answer(holder);
      if (sql.includes("sharing_user_ids")) return answer(group);
      throw new Error(`unexpected statement: ${sql}`);
    });

  const lookups: Array<[string, unknown[]]> = [
    [FIND_HOLDER, ["friend@example.com", 1]],
    [SELECT_GROUP, ["u-alice"]],
  ];
  const write = (upsertValues: unknown[] = ["u-alice", "friend@example.com", EXPIRES_AT]) => [
    BEGIN,
    [LOCK_SENDER, ["u-alice"]],
    [SELECT_SENT, ["u-alice"]],
    [UPSERT_INVITATION, upsertValues],
    COMMIT,
  ];

  test("the demo account can't invite, and no statement runs", async () => {
    expect(await inviteByEmail(demo, "friend@example.com")).toEqual(DEMO_REFUSAL);

    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockReservedUnsafe).not.toHaveBeenCalled();
  });

  test("an address nobody has yet gets an invitation open for thirty days, stored trimmed and in lower case", async () => {
    expect(EMAIL_INVITATION_LIFETIME_MS).toBe(30 * 24 * 60 * 60 * 1000);
    answerLookups([], ids(alice));
    queue(mockReservedUnsafe, answer(), answer(), answer(), answer([emailInvitationRow("inv-e1")]));

    expect(await inviteByEmail(alice, "  Friend@Example.COM ")).toEqual({
      ok: true,
      invitation: {
        invitation_id: "inv-e1",
        inviter: alice,
        invitee: { email: "friend@example.com" },
        expires_at: EXPIRES_AT,
      },
      invitee_user_id: undefined,
    });

    expect(statements(mockUnsafe)).toEqual(lookups);
    expect(statements(mockReservedUnsafe)).toEqual(write());
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  test("an address someone outside the group has runs the same statements and answers alike, naming that user only for the event", async () => {
    answerLookups([holderRow(bob, "Friend@example.com")], ids(alice));
    queue(mockReservedUnsafe, answer(), answer(), answer(), answer([emailInvitationRow("inv-e1")]));

    const result = await inviteByEmail(alice, "friend@example.com");

    expect(result).toEqual({
      ok: true,
      invitation: {
        invitation_id: "inv-e1",
        inviter: alice,
        invitee: { email: "friend@example.com" },
        expires_at: EXPIRES_AT,
      },
      invitee_user_id: "u-bob",
    });
    // Nothing the inviter is shown names the user behind the address.
    expect(JSON.stringify(result.ok && result.invitation)).not.toContain("bob");
    // A sender timing the request learns nothing either: the work is the same as for nobody.
    expect(statements(mockUnsafe)).toEqual(lookups);
    expect(statements(mockReservedUnsafe)).toEqual(write());
  });

  test("refuses the user's own address, and writes nothing", async () => {
    answerLookups([holderRow(alice, "friend@example.com")], ids(alice));

    expect(await inviteByEmail(alice, "friend@example.com")).toEqual({
      ok: false,
      error: "You can't invite yourself.",
    });

    expect(statements(mockUnsafe)).toEqual(lookups);
    expect(mockReservedUnsafe).not.toHaveBeenCalled();
  });

  test("refuses the address of someone already in the user's group, and writes nothing", async () => {
    answerLookups([holderRow(bob, "friend@example.com")], ids(bob, alice));

    expect(await inviteByEmail(alice, "friend@example.com")).toEqual({
      ok: false,
      error: "You already share data with bob.",
    });

    expect(statements(mockUnsafe)).toEqual(lookups);
    expect(mockReservedUnsafe).not.toHaveBeenCalled();
  });

  test("inviting an address again answers the same invitation, open thirty days from now", async () => {
    // The conflict on (inviter, address) rewrites only the lapse time of the row already there.
    answerLookups([], ids(alice));
    queue(
      mockReservedUnsafe,
      answer(),
      answer(),
      answer([emailInvitationRow("inv-open", "friend@example.com", "2026-11-30T00:00:00.000Z")]),
      answer([emailInvitationRow("inv-open")]),
    );

    const result = await inviteByEmail(alice, "friend@example.com");

    expect(result.ok && result.invitation.invitation_id).toBe("inv-open");
    expect(result.ok && result.invitation.expires_at).toBe(EXPIRES_AT);
    expect(statements(mockReservedUnsafe)).toEqual(write());
  });

  test(`a user with ${EMAIL_INVITATIONS_PER_USER} invitations to other addresses can't send another, and nothing is written`, async () => {
    expect(EMAIL_INVITATIONS_PER_USER).toBe(20);
    answerLookups([], ids(alice));
    queue(mockReservedUnsafe, answer(), answer(), answer(sentElsewhere(20)));

    expect(await inviteByEmail(alice, "friend@example.com")).toEqual({
      ok: false,
      error: "You have 20 invitations sent to email addresses. Withdraw one before sending another.",
    });

    expect(statements(mockReservedUnsafe)).toEqual([
      BEGIN,
      [LOCK_SENDER, ["u-alice"]],
      [SELECT_SENT, ["u-alice"]],
      COMMIT,
    ]);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  test("one under the limit can still send", async () => {
    answerLookups([], ids(alice));
    queue(
      mockReservedUnsafe,
      answer(),
      answer(),
      answer(sentElsewhere(19)),
      answer([emailInvitationRow("inv-e1")]),
    );

    expect((await inviteByEmail(alice, "friend@example.com")).ok).toBe(true);
    expect(statements(mockReservedUnsafe)).toEqual(write());
  });

  test("at the limit, sending to an address already invited renews it, since it adds no row", async () => {
    answerLookups([], ids(alice));
    queue(
      mockReservedUnsafe,
      answer(),
      answer(),
      answer([...sentElsewhere(19), emailInvitationRow("inv-open")]),
      answer([emailInvitationRow("inv-open")]),
    );

    const result = await inviteByEmail(alice, "friend@example.com");

    expect(result.ok && result.invitation.invitation_id).toBe("inv-open");
    expect(statements(mockReservedUnsafe)).toEqual(write());
  });
});

describe("deleteSharingInvitation", () => {
  const DELETE_INVITATION =
    "DELETE FROM sharing_invitations i" +
    ` WHERE i.invitation_id = $2 AND ${CONCERNS_USER}` +
    " RETURNING i.inviter_user_id, i.invitee_user_id";

  test("deletes an invitation that concerns the user and answers the two people it was between", async () => {
    queue(mockUnsafe, answer([{ inviter_user_id: "u-bob", invitee_user_id: "u-carol" }]));

    expect(await deleteSharingInvitation(alice, "inv-1")).toEqual({
      affected_user_ids: ["u-bob", "u-carol"],
    });

    expect(statements(mockUnsafe)).toEqual([[DELETE_INVITATION, ["u-alice", "inv-1"]]]);
    expect(mockReservedUnsafe).not.toHaveBeenCalled();
  });

  const DELETE_EMAIL_INVITATION =
    "DELETE FROM sharing_email_invitations e" +
    ` WHERE e.invitation_id = $2 AND ${EMAIL_CONCERNS_USER}` +
    " RETURNING e.inviter_user_id," +
    " (SELECT u.user_id FROM users u WHERE lower(u.email) = e.invitee_email) AS invitee_user_id";

  test("an invitation to a user is deleted without looking among the email invitations", async () => {
    queue(mockUnsafe, answer([{ inviter_user_id: "u-bob", invitee_user_id: "u-alice" }]));

    await deleteSharingInvitation(alice, "inv-1");

    expect(statements(mockUnsafe)).toEqual([[DELETE_INVITATION, ["u-alice", "inv-1"]]]);
  });

  test("otherwise deletes an email invitation that concerns the user, and answers its inviter and the user with the address", async () => {
    queue(mockUnsafe, answer(), answer([{ inviter_user_id: "u-bob", invitee_user_id: "u-alice" }]));

    expect(await deleteSharingInvitation(alice, "inv-e1")).toEqual({
      affected_user_ids: ["u-bob", "u-alice"],
    });

    expect(statements(mockUnsafe)).toEqual([
      [DELETE_INVITATION, ["u-alice", "inv-e1"]],
      [DELETE_EMAIL_INVITATION, ["u-alice", "inv-e1"]],
    ]);
    expect(mockReservedUnsafe).not.toHaveBeenCalled();
  });

  test("an email invitation to an address nobody has answers its inviter alone", async () => {
    queue(mockUnsafe, answer(), answer([{ inviter_user_id: "u-alice", invitee_user_id: null }]));

    expect(await deleteSharingInvitation(alice, "inv-e1")).toEqual({
      affected_user_ids: ["u-alice"],
    });
  });

  test("answers undefined when nothing was deleted from either table", async () => {
    queue(mockUnsafe, answer(), answer());

    expect(await deleteSharingInvitation(alice, "inv-1")).toBeUndefined();

    expect(statements(mockUnsafe)).toEqual([
      [DELETE_INVITATION, ["u-alice", "inv-1"]],
      [DELETE_EMAIL_INVITATION, ["u-alice", "inv-1"]],
    ]);
  });
});

describe("acceptSharingInvitation", () => {
  // Sent to the user, or open, sent to their address, and not by themself.
  const FIND_INVITATION =
    "SELECT inviter_user_id FROM sharing_invitations WHERE invitation_id = $1 AND invitee_user_id = $2" +
    " UNION ALL" +
    " SELECT e.inviter_user_id FROM sharing_email_invitations e" +
    ` WHERE e.invitation_id = $1 AND e.inviter_user_id <> $2 AND ${openTo("$2")}`;
  const FIND_MEMBERSHIPS = "SELECT * FROM sharing_members WHERE user_id IN ($1, $2)";
  const INSERT_MEMBERS =
    "INSERT INTO sharing_members (updated, user_id, group_id)" +
    " VALUES (CURRENT_TIMESTAMP, $1, $2), (CURRENT_TIMESTAMP, $3, $4)" +
    " ON CONFLICT (user_id) DO NOTHING RETURNING *";
  const DELETE_SETTLED_INVITATIONS =
    "DELETE FROM sharing_invitations i USING sharing_members inviter, sharing_members invitee" +
    " WHERE inviter.user_id = i.inviter_user_id AND invitee.user_id = i.invitee_user_id" +
    " AND inviter.group_id = $1 AND invitee.group_id = $1";
  // An email invitation is settled once its inviter and the user with the address share.
  const DELETE_SETTLED_EMAIL_INVITATIONS =
    "DELETE FROM sharing_email_invitations e" +
    " USING sharing_members inviter, sharing_members invitee, users u" +
    " WHERE inviter.user_id = e.inviter_user_id AND u.user_id = invitee.user_id" +
    " AND lower(u.email) = e.invitee_email" +
    " AND inviter.group_id = $1 AND invitee.group_id = $1";

  // Bob accepts the invitation alice sent him.
  const findInvitation: [string, unknown[]] = [FIND_INVITATION, ["inv-1", "u-bob"]];
  const findMemberships: [string, unknown[]] = [FIND_MEMBERSHIPS, ["u-bob", "u-alice"]];
  const invitationFromAlice = answer([{ inviter_user_id: "u-alice" }]);

  test("refuses the demo account before reserving a connection", async () => {
    expect(await acceptSharingInvitation(demo, "inv-1")).toEqual(DEMO_REFUSAL);

    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockReservedUnsafe).not.toHaveBeenCalled();
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("refuses an invitation that is not addressed to the user, having only read it", async () => {
    queueTransaction(answer());

    expect(await acceptSharingInvitation(bob, "inv-1")).toEqual({
      ok: false,
      error: "That invitation is no longer open.",
    });

    expect(statements(mockReservedUnsafe)).toEqual([BEGIN, LOCK, findInvitation, COMMIT]);
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  test("refuses a user who already belongs to a group, and writes nothing", async () => {
    queueTransaction(invitationFromAlice, answer([memberRow("u-bob", "g-bob")]));

    expect(await acceptSharingInvitation(bob, "inv-1")).toEqual({
      ok: false,
      error: "Stop sharing with your current group before joining another.",
    });

    expect(statements(mockReservedUnsafe)).toEqual([
      BEGIN,
      LOCK,
      findInvitation,
      findMemberships,
      COMMIT,
    ]);
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("creates a group for an inviter who shared with nobody, and puts both people in it", async () => {
    queueTransaction(invitationFromAlice, answer(), answer(), answer(), answer(), answer(ids(alice, bob)));

    expect(await acceptSharingInvitation(bob, "inv-1")).toEqual({
      ok: true,
      affected_user_ids: ["u-alice", "u-bob"],
    });

    const ran = statements(mockReservedUnsafe);
    const groupId = ran[4][1][1] as string;
    expect(groupId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ran).toEqual([
      BEGIN,
      LOCK,
      findInvitation,
      findMemberships,
      [INSERT_MEMBERS, ["u-alice", groupId, "u-bob", groupId]],
      [DELETE_SETTLED_INVITATIONS, [groupId]],
      [DELETE_SETTLED_EMAIL_INVITATIONS, [groupId]],
      [SELECT_GROUP, ["u-bob"]],
      COMMIT,
    ]);
    // On the pool, any of these would commit outside the transaction and its lock.
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  test("joins the group the inviter is already in, and answers everyone in it", async () => {
    queueTransaction(
      invitationFromAlice,
      answer([memberRow("u-alice", "g-alice")]),
      answer(),
      answer(),
      answer(),
      answer(ids(alice, carol, bob)),
    );

    expect(await acceptSharingInvitation(bob, "inv-1")).toEqual({
      ok: true,
      affected_user_ids: ["u-alice", "u-carol", "u-bob"],
    });

    expect(statements(mockReservedUnsafe)).toEqual([
      BEGIN,
      LOCK,
      findInvitation,
      findMemberships,
      [INSERT_MEMBERS, ["u-alice", "g-alice", "u-bob", "g-alice"]],
      [DELETE_SETTLED_INVITATIONS, ["g-alice"]],
      [DELETE_SETTLED_EMAIL_INVITATIONS, ["g-alice"]],
      [SELECT_GROUP, ["u-bob"]],
      COMMIT,
    ]);
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("rolls everything back when a write fails", async () => {
    const failure = new Error("insert failed");
    queueTransaction(invitationFromAlice, answer());
    mockReservedUnsafe.mockRejectedValueOnce(failure);

    await expect(acceptSharingInvitation(bob, "inv-1")).rejects.toBe(failure);

    expect(statements(mockReservedUnsafe).map(([sql]) => sql)).toEqual([
      "BEGIN",
      LOCK[0],
      FIND_INVITATION,
      FIND_MEMBERSHIPS,
      INSERT_MEMBERS,
      "ROLLBACK",
    ]);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});

describe("removeSharingMember", () => {
  const NOT_SHARING = { ok: false, error: "You don't share data with that user." } as const;

  const DELETE_MEMBERS = "DELETE FROM sharing_members WHERE user_id = ANY($1::uuid[])";
  // A live pair owned by a former member, with exactly one side owned by the removed one.
  const DELETE_SPLIT_PAIRS =
    "UPDATE transaction_pairs pair SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP" +
    " FROM transactions a, transactions b" +
    " WHERE a.transaction_id = pair.transaction_id_a AND b.transaction_id = pair.transaction_id_b" +
    " AND pair.user_id = ANY($1::uuid[])" +
    " AND (pair.is_deleted IS NULL OR pair.is_deleted = FALSE)" +
    " AND (a.user_id = $2) <> (b.user_id = $2)";

  const selectGroup: [string, unknown[]] = [SELECT_GROUP, ["u-alice"]];
  const readOnly = [BEGIN, LOCK, selectGroup, COMMIT];

  test("refuses a target outside the user's group, and writes nothing", async () => {
    queueTransaction(answer(ids(bob, alice)));

    expect(await removeSharingMember(alice, "u-carol")).toEqual(NOT_SHARING);

    expect(statements(mockReservedUnsafe)).toEqual(readOnly);
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  test("refuses a user who shares with nobody, and writes nothing", async () => {
    queueTransaction(answer(ids(alice)));

    expect(await removeSharingMember(alice, "u-bob")).toEqual(NOT_SHARING);

    expect(statements(mockReservedUnsafe)).toEqual(readOnly);
  });

  test("refuses leaving while sharing with nobody, though the user is in their own id list", async () => {
    queueTransaction(answer(ids(alice)));

    expect(await removeSharingMember(alice, "u-alice")).toEqual(NOT_SHARING);

    expect(statements(mockReservedUnsafe)).toEqual(readOnly);
  });

  test("in a group of three, removes only the named member's membership", async () => {
    queueTransaction(answer(ids(bob, carol, alice)));

    expect(await removeSharingMember(alice, "u-bob")).toEqual({
      ok: true,
      affected_user_ids: ["u-bob", "u-carol", "u-alice"],
    });

    expect(statements(mockReservedUnsafe)).toEqual([
      BEGIN,
      LOCK,
      selectGroup,
      [DELETE_MEMBERS, [["u-bob"]]],
      [DELETE_SPLIT_PAIRS, [["u-bob", "u-carol", "u-alice"], "u-bob"]],
      COMMIT,
    ]);
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  test("in a group of three, a user leaving removes only their own membership", async () => {
    queueTransaction(answer(ids(bob, carol, alice)));

    expect(await removeSharingMember(alice, "u-alice")).toEqual({
      ok: true,
      affected_user_ids: ["u-bob", "u-carol", "u-alice"],
    });

    expect(statements(mockReservedUnsafe)).toEqual([
      BEGIN,
      LOCK,
      selectGroup,
      [DELETE_MEMBERS, [["u-alice"]]],
      [DELETE_SPLIT_PAIRS, [["u-bob", "u-carol", "u-alice"], "u-alice"]],
      COMMIT,
    ]);
  });

  test("in a group of two, removing the other member dissolves the group: both memberships go", async () => {
    queueTransaction(answer(ids(bob, alice)));

    expect(await removeSharingMember(alice, "u-bob")).toEqual({
      ok: true,
      affected_user_ids: ["u-bob", "u-alice"],
    });

    expect(statements(mockReservedUnsafe)).toEqual([
      BEGIN,
      LOCK,
      selectGroup,
      [DELETE_MEMBERS, [["u-bob", "u-alice"]]],
      [DELETE_SPLIT_PAIRS, [["u-bob", "u-alice"], "u-bob"]],
      COMMIT,
    ]);
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("in a group of two, a user leaving dissolves the group and splits pairs on their own id", async () => {
    queueTransaction(answer(ids(bob, alice)));

    expect(await removeSharingMember(alice, "u-alice")).toEqual({
      ok: true,
      affected_user_ids: ["u-bob", "u-alice"],
    });

    expect(statements(mockReservedUnsafe)).toEqual([
      BEGIN,
      LOCK,
      selectGroup,
      [DELETE_MEMBERS, [["u-bob", "u-alice"]]],
      [DELETE_SPLIT_PAIRS, [["u-bob", "u-alice"], "u-alice"]],
      COMMIT,
    ]);
  });

  test("rolls the membership delete back when the pair cleanup fails", async () => {
    const failure = new Error("update failed");
    queueTransaction(answer(ids(bob, alice)), answer());
    mockReservedUnsafe.mockRejectedValueOnce(failure);

    await expect(removeSharingMember(alice, "u-bob")).rejects.toBe(failure);

    expect(statements(mockReservedUnsafe).map(([sql]) => sql)).toEqual([
      "BEGIN",
      LOCK[0],
      SELECT_GROUP,
      DELETE_MEMBERS,
      DELETE_SPLIT_PAIRS,
      "ROLLBACK",
    ]);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});
