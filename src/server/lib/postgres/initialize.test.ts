import { describe, test, expect, mock, spyOn, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";
import { logger } from "../logger";

/** Every statement, from the pool and the migration's reserved connection, in the order run. */
let statements: string[] = [];
/** What the users table holds more than once, as the duplicate-key query reports it. */
let duplicateEmails: string[] = [];

/** Some of a sessions table as it stood before single sign-on added its columns. */
const OLD_SESSION_COLUMNS = [
  ["session_id", "character varying", "varchar"],
  ["user_user_id", "uuid", "uuid"],
  ["cookie_expires", "timestamp with time zone", "timestamptz"],
];

const DUPLICATE_EMAILS_SQL =
  "SELECT lower(email) FROM users WHERE lower(email) IS NOT NULL AND (email IS NOT NULL)" +
  " GROUP BY lower(email) HAVING COUNT(*) > 1 ORDER BY lower(email)";
const EMAIL_INDEX_SQL =
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_lower_email ON users(lower(email)) WHERE email IS NOT NULL";

const { driver } = createFakeSql(async (sql: string, values?: unknown[]) => {
  statements.push(sql.trim());
  if (sql.includes("information_schema.columns") && values?.[0] === "sessions") {
    const rows = OLD_SESSION_COLUMNS.map(([column_name, data_type, udt_name]) => ({
      column_name,
      data_type,
      udt_name,
      is_nullable: "YES",
      column_default: null,
    }));
    return { rows, rowCount: rows.length };
  }
  if (sql === DUPLICATE_EMAILS_SQL) {
    const rows = duplicateEmails.map((email) => ({ lower: email }));
    return { rows, rowCount: rows.length };
  }
  if (sql.startsWith("INSERT INTO users")) return { rows: [{ user_id: "u-1" }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
});
mock.module("./sql-driver", () => driver);
mock.module("../password", () => ({ hashPassword: async (s: string) => `hashed:${s}` }));

const { initializePostgres } = await import("./initialize");
const { CREATE_SHARING_USER_IDS_FUNCTION } = await import("./models");

afterAll(restoreLeaves);

beforeEach(() => {
  statements = [];
  duplicateEmails = [];
});

describe("initializePostgres", () => {
  test("creates indexes only after the migration has added the columns they cover", async () => {
    await initializePostgres();

    const added = statements.findIndex((s) =>
      s.startsWith("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS auth_sid"),
    );
    const committed = statements.indexOf("COMMIT");
    const indexes = statements
      .map((s, i) => [s, i] as const)
      .filter(([s]) => /^CREATE (UNIQUE )?INDEX/.test(s));

    expect(added).toBeGreaterThan(-1);
    expect(committed).toBeGreaterThan(added);
    expect(indexes.map(([s]) => s)).toContain(
      "CREATE INDEX IF NOT EXISTS idx_sessions_auth_sid ON sessions(auth_sid)",
    );
    expect(indexes.map(([s]) => s)).toContain(EMAIL_INDEX_SQL);
    expect(indexes.filter(([, i]) => i < committed)).toEqual([]);
  });

  test("checks the users' emails for duplicates right before indexing them uniquely", async () => {
    await initializePostgres();

    const checked = statements.indexOf(DUPLICATE_EMAILS_SQL);
    expect(checked).toBeGreaterThan(statements.indexOf("COMMIT"));
    expect(statements[checked + 1]).toBe(EMAIL_INDEX_SQL);
  });

  test("creates sharing_user_ids once, after the sharing_members table its body reads", async () => {
    await initializePostgres();

    const membersTable = statements.findIndex((s) =>
      s.startsWith("CREATE TABLE IF NOT EXISTS sharing_members ("),
    );
    const functions = statements
      .map((s, i) => [s, i] as const)
      .filter(([s]) => s.startsWith("CREATE OR REPLACE FUNCTION"));

    expect(membersTable).toBeGreaterThan(-1);
    expect(functions.map(([s]) => s)).toEqual([CREATE_SHARING_USER_IDS_FUNCTION]);
    expect(functions[0][0].startsWith("CREATE OR REPLACE FUNCTION sharing_user_ids(")).toBe(true);
    expect(functions[0][1]).toBeGreaterThan(membersTable);
  });

  test("creates both sharing tables after the users table they reference, and indexes their lookup columns", async () => {
    await initializePostgres();

    const tables = statements
      .filter((s) => s.startsWith("CREATE TABLE IF NOT EXISTS "))
      .map((s) => s.slice("CREATE TABLE IF NOT EXISTS ".length, s.indexOf(" (")));
    expect(tables.filter((name) => name.startsWith("sharing_"))).toEqual([
      "sharing_members",
      "sharing_invitations",
    ]);
    expect(tables.indexOf("users")).toBeGreaterThan(-1);
    expect(tables.indexOf("sharing_members")).toBeGreaterThan(tables.indexOf("users"));
    expect(statements.filter((s) => /^CREATE (UNIQUE )?INDEX .* ON sharing_/.test(s))).toEqual([
      "CREATE INDEX IF NOT EXISTS idx_sharing_members_group_id ON sharing_members(group_id)",
      "CREATE INDEX IF NOT EXISTS idx_sharing_invitations_invitee_user_id ON sharing_invitations(invitee_user_id)",
    ]);
  });

  test("users sharing an email stop the start, naming the shared addresses and nothing else", async () => {
    duplicateEmails = ["alice@example.com", "bob@example.com"];
    const error = spyOn(logger, "error").mockImplementation(() => {});
    try {
      await expect(initializePostgres()).rejects.toThrow("Failed to setup PostgreSQL tables.");
      expect(error).toHaveBeenCalledWith(
        "These values of lower(email) are shared by more than one users row, and must be unique." +
          " Change the rows so no two match, then start again:\n" +
          "- alice@example.com\n" +
          "- bob@example.com",
      );
    } finally {
      error.mockRestore();
    }
    expect(statements).toContain(DUPLICATE_EMAILS_SQL);
    expect(statements).not.toContain(EMAIL_INDEX_SQL);
    expect(statements.some((s) => s.startsWith("INSERT INTO users"))).toBe(false);
  });
});
