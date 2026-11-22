import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";
import { SHARING_USER_IDS, buildCreateTable } from "../database";

const { driver, mockUnsafe, resetSqlMocks } = createFakeSql();

mock.module("../sql-driver", () => driver);

const { ModelValidationError } = await import("./base");
const {
  sharingMembersTable,
  sharingInvitationsTable,
  sharingEmailInvitationsTable,
  SharingMemberModel,
  SharingInvitationModel,
  SharingEmailInvitationModel,
  CREATE_SHARING_USER_IDS_FUNCTION,
} = await import("./sharing");

afterAll(restoreLeaves);

beforeEach(resetSqlMocks);

const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

const lastCall = () => {
  const [sql, values] = mockUnsafe.mock.calls.at(-1) as [string, unknown[]];
  return { sql, values };
};

const memberRow = (overrides: Record<string, unknown> = {}) => ({
  user_id: "u-1",
  group_id: "g-1",
  updated: "2026-05-19T00:00:00.000Z",
  ...overrides,
});

const invitationRow = (overrides: Record<string, unknown> = {}) => ({
  invitation_id: "inv-1",
  inviter_user_id: "u-1",
  invitee_user_id: "u-2",
  updated: "2026-05-19T00:00:00.000Z",
  ...overrides,
});

describe("sharingMembersTable", () => {
  test("is keyed on the user, so a user is in at most one group", () => {
    expect(sharingMembersTable.name).toBe("sharing_members");
    expect(sharingMembersTable.primaryKey).toBe("user_id");
    expect(
      flat(
        buildCreateTable(
          "sharing_members",
          sharingMembersTable.schema,
          sharingMembersTable.constraints,
        ),
      ),
    ).toBe(
      "CREATE TABLE IF NOT EXISTS sharing_members (" +
        " user_id UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE," +
        " group_id UUID NOT NULL," +
        " updated TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP )",
    );
  });

  test("indexes the group, the column every membership lookup filters on", () => {
    expect(sharingMembersTable.indexes).toEqual([{ column: "group_id" }]);
  });

  test("has no is_deleted column, and reads carry no soft-delete predicate", async () => {
    expect(sharingMembersTable.supportsSoftDelete).toBe(false);
    expect(Object.keys(sharingMembersTable.schema)).toEqual(["user_id", "group_id", "updated"]);

    mockUnsafe.mockResolvedValueOnce({ rows: [memberRow()], rowCount: 1 });
    const members = await sharingMembersTable.query({ group_id: "g-1" });
    expect(members.map((m) => m.toJSON())).toEqual([{ user_id: "u-1", group_id: "g-1" }]);
    expect(lastCall().sql).toBe("SELECT * FROM sharing_members WHERE group_id = $1");
    expect(lastCall().values).toEqual(["g-1"]);
  });
});

describe("sharingInvitationsTable", () => {
  test("is keyed on a generated id and holds one invitation per ordered pair of users", () => {
    expect(sharingInvitationsTable.name).toBe("sharing_invitations");
    expect(sharingInvitationsTable.primaryKey).toBe("invitation_id");
    expect(sharingInvitationsTable.constraints).toEqual([
      "CONSTRAINT sharing_invitations_pair_unique UNIQUE (inviter_user_id, invitee_user_id)",
    ]);
    expect(
      flat(
        buildCreateTable(
          "sharing_invitations",
          sharingInvitationsTable.schema,
          sharingInvitationsTable.constraints,
        ),
      ),
    ).toBe(
      "CREATE TABLE IF NOT EXISTS sharing_invitations (" +
        " invitation_id UUID PRIMARY KEY DEFAULT gen_random_uuid()," +
        " inviter_user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE," +
        " invitee_user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE," +
        " updated TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP," +
        " CONSTRAINT sharing_invitations_pair_unique UNIQUE (inviter_user_id, invitee_user_id) )",
    );
  });

  test("indexes the invitee; the unique constraint already serves lookups by inviter", () => {
    expect(sharingInvitationsTable.indexes).toEqual([{ column: "invitee_user_id" }]);
  });

  test("has no is_deleted column, and reads carry no soft-delete predicate", async () => {
    expect(sharingInvitationsTable.supportsSoftDelete).toBe(false);
    expect(Object.keys(sharingInvitationsTable.schema)).toEqual([
      "invitation_id",
      "inviter_user_id",
      "invitee_user_id",
      "updated",
    ]);

    mockUnsafe.mockResolvedValueOnce({ rows: [invitationRow()], rowCount: 1 });
    const invitations = await sharingInvitationsTable.query({ invitee_user_id: "u-2" });
    expect(invitations.map((i) => i.toJSON())).toEqual([
      { invitation_id: "inv-1", inviter_user_id: "u-1", invitee_user_id: "u-2" },
    ]);
    expect(lastCall().sql).toBe("SELECT * FROM sharing_invitations WHERE invitee_user_id = $1");
    expect(lastCall().values).toEqual(["u-2"]);
  });

  test("the unique constraint is not a composite primary key, so the single-key writes stay available", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [{ invitation_id: "inv-1" }], rowCount: 1 });
    expect(
      await sharingInvitationsTable.insert({ inviter_user_id: "u-1", invitee_user_id: "u-2" }),
    ).toEqual({ invitation_id: "inv-1" });
    expect(lastCall().sql).toBe(
      "INSERT INTO sharing_invitations (updated, inviter_user_id, invitee_user_id) VALUES (CURRENT_TIMESTAMP, $1, $2) RETURNING invitation_id",
    );
  });
});

const emailInvitationRow = (overrides: Record<string, unknown> = {}) => ({
  invitation_id: "inv-e1",
  inviter_user_id: "u-1",
  invitee_email: "friend@example.com",
  expires_at: "2026-12-22T00:00:00.000Z",
  updated: "2026-11-22T00:00:00.000Z",
  ...overrides,
});

describe("sharingEmailInvitationsTable", () => {
  test("is keyed on a generated id and holds one invitation per inviter and address, each with a lapse time", () => {
    expect(sharingEmailInvitationsTable.name).toBe("sharing_email_invitations");
    expect(sharingEmailInvitationsTable.primaryKey).toBe("invitation_id");
    expect(sharingEmailInvitationsTable.constraints).toEqual([
      "CONSTRAINT sharing_email_invitations_pair_unique UNIQUE (inviter_user_id, invitee_email)",
    ]);
    expect(
      flat(
        buildCreateTable(
          "sharing_email_invitations",
          sharingEmailInvitationsTable.schema,
          sharingEmailInvitationsTable.constraints,
        ),
      ),
    ).toBe(
      "CREATE TABLE IF NOT EXISTS sharing_email_invitations (" +
        " invitation_id UUID PRIMARY KEY DEFAULT gen_random_uuid()," +
        " inviter_user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE," +
        " invitee_email VARCHAR(255) NOT NULL," +
        " expires_at TIMESTAMPTZ NOT NULL," +
        " updated TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP," +
        " CONSTRAINT sharing_email_invitations_pair_unique UNIQUE (inviter_user_id, invitee_email) )",
    );
  });

  test("indexes the address; the unique constraint already serves lookups by inviter", () => {
    expect(sharingEmailInvitationsTable.indexes).toEqual([{ column: "invitee_email" }]);
  });

  test("has no is_deleted column, and reads carry no soft-delete predicate", async () => {
    expect(sharingEmailInvitationsTable.supportsSoftDelete).toBe(false);
    expect(Object.keys(sharingEmailInvitationsTable.schema)).toEqual([
      "invitation_id",
      "inviter_user_id",
      "invitee_email",
      "expires_at",
      "updated",
    ]);

    mockUnsafe.mockResolvedValueOnce({ rows: [emailInvitationRow()], rowCount: 1 });
    const invitations = await sharingEmailInvitationsTable.query({ inviter_user_id: "u-1" });
    expect(invitations.map((i) => i.toJSON())).toEqual([
      {
        invitation_id: "inv-e1",
        inviter_user_id: "u-1",
        invitee_email: "friend@example.com",
        expires_at: "2026-12-22T00:00:00.000Z",
      },
    ]);
    expect(lastCall().sql).toBe("SELECT * FROM sharing_email_invitations WHERE inviter_user_id = $1");
  });

  test("an upsert finds the existing invitation by inviter and address, and rewrites only what it is told to", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [emailInvitationRow()], rowCount: 1 });
    await sharingEmailInvitationsTable.upsert(
      {
        inviter_user_id: "u-1",
        invitee_email: "friend@example.com",
        expires_at: "2026-12-22T00:00:00.000Z",
      },
      ["expires_at"],
      undefined,
      { conflictColumns: ["inviter_user_id", "invitee_email"] },
    );
    expect(lastCall().sql).toBe(
      "INSERT INTO sharing_email_invitations (updated, inviter_user_id, invitee_email, expires_at)" +
        " VALUES (CURRENT_TIMESTAMP, $1, $2, $3)" +
        " ON CONFLICT (inviter_user_id, invitee_email)" +
        " DO UPDATE SET expires_at = EXCLUDED.expires_at, updated = CURRENT_TIMESTAMP RETURNING *",
    );
    expect(lastCall().values).toEqual(["u-1", "friend@example.com", "2026-12-22T00:00:00.000Z"]);
  });
});

describe("SharingEmailInvitationModel", () => {
  test("toJSON keeps the id, the inviter, the address and the lapse time, and drops the timestamp", () => {
    const invitation = new SharingEmailInvitationModel(emailInvitationRow());
    expect(invitation.toJSON()).toEqual({
      invitation_id: "inv-e1",
      inviter_user_id: "u-1",
      invitee_email: "friend@example.com",
      expires_at: "2026-12-22T00:00:00.000Z",
    });
    expect(invitation.updated).toBe("2026-11-22T00:00:00.000Z");
  });

  test("refuses a row with a malformed column, naming each one", () => {
    let thrown: unknown;
    try {
      new SharingEmailInvitationModel(emailInvitationRow({ invitee_email: null, expires_at: 3 }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ModelValidationError);
    expect((thrown as InstanceType<typeof ModelValidationError>).errors).toEqual([
      "invitee_email: null (object)",
      "expires_at: 3 (number)",
    ]);
  });
});

describe("SharingMemberModel", () => {
  test("toJSON keeps the user and the group and drops the timestamp", () => {
    const member = new SharingMemberModel(memberRow());
    expect(member.toJSON()).toEqual({ user_id: "u-1", group_id: "g-1" });
    expect(member.updated).toBe("2026-05-19T00:00:00.000Z");
  });

  test("accepts a row whose timestamp is null", () => {
    expect(new SharingMemberModel(memberRow({ updated: null })).updated).toBeNull();
  });

  test("refuses a row with a malformed column, naming each one", () => {
    let thrown: unknown;
    try {
      new SharingMemberModel({ user_id: "u-1", group_id: 7, updated: 1 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ModelValidationError);
    expect((thrown as InstanceType<typeof ModelValidationError>).errors).toEqual([
      "group_id: 7 (number)",
      "updated: 1 (number)",
    ]);
  });

  test("refuses a row with no user", () => {
    expect(() => new SharingMemberModel({ group_id: "g-1", updated: null })).toThrow(
      "SharingMemberModel validation failed:\nuser_id: undefined (undefined)",
    );
  });
});

describe("SharingInvitationModel", () => {
  test("toJSON keeps the id and both users and drops the timestamp", () => {
    const invitation = new SharingInvitationModel(invitationRow());
    expect(invitation.toJSON()).toEqual({
      invitation_id: "inv-1",
      inviter_user_id: "u-1",
      invitee_user_id: "u-2",
    });
    expect(invitation.updated).toBe("2026-05-19T00:00:00.000Z");
  });

  test("refuses a row with a malformed column, naming each one", () => {
    let thrown: unknown;
    try {
      new SharingInvitationModel({
        invitation_id: "inv-1",
        inviter_user_id: null,
        invitee_user_id: 2,
        updated: null,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ModelValidationError);
    expect((thrown as InstanceType<typeof ModelValidationError>).errors).toEqual([
      "inviter_user_id: null (object)",
      "invitee_user_id: 2 (number)",
    ]);
  });

  test("refuses a row with no id", () => {
    expect(
      () => new SharingInvitationModel({ inviter_user_id: "u-1", invitee_user_id: "u-2", updated: null }),
    ).toThrow("SharingInvitationModel validation failed:\ninvitation_id: undefined (undefined)");
  });
});

describe("CREATE_SHARING_USER_IDS_FUNCTION", () => {
  // The statement is `<signature> $$ <body> $$`. Splitting on the dollar quotes
  // pins each part whole, so a clause added to either one fails here.
  const [signature, body, tail, ...rest] = CREATE_SHARING_USER_IDS_FUNCTION.split("$$").map(flat);

  test("is one dollar-quoted statement with nothing after the body", () => {
    expect(rest).toEqual([]);
    expect(tail).toBe("");
    expect(CREATE_SHARING_USER_IDS_FUNCTION).toBe(CREATE_SHARING_USER_IDS_FUNCTION.trim());
  });

  test("replaces sharing_user_ids(viewer UUID) RETURNS UUID[], stable and parallel safe", () => {
    expect(signature).toBe(
      "CREATE OR REPLACE FUNCTION sharing_user_ids(viewer UUID) RETURNS UUID[]" +
        " LANGUAGE sql STABLE PARALLEL SAFE AS",
    );
  });

  test("is named by the constant every sharedWith predicate calls", () => {
    expect(signature.startsWith(`CREATE OR REPLACE FUNCTION ${SHARING_USER_IDS}(viewer UUID) `)).toBe(true);
  });

  test("answers the viewer's group peers with the viewer appended", () => {
    expect(body).toBe(
      "SELECT array_append(" +
        " ARRAY(" +
        " SELECT peer.user_id FROM sharing_members peer" +
        " WHERE peer.user_id <> viewer" +
        " AND peer.group_id = (" +
        " SELECT own.group_id FROM sharing_members own WHERE own.user_id = viewer" +
        " )" +
        " )," +
        " viewer" +
        " )",
    );
  });
});
