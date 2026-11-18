import { describe, test, expect, mock, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";

/** Every statement, from the pool and the migration's reserved connection, in the order run. */
const statements: string[] = [];

/** Some of a sessions table as it stood before single sign-on added its columns. */
const OLD_SESSION_COLUMNS = [
  ["session_id", "character varying", "varchar"],
  ["user_user_id", "uuid", "uuid"],
  ["cookie_expires", "timestamp with time zone", "timestamptz"],
];

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
  if (sql.startsWith("INSERT INTO users")) return { rows: [{ user_id: "u-1" }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
});
mock.module("./sql-driver", () => driver);
mock.module("../password", () => ({ hashPassword: async (s: string) => `hashed:${s}` }));

const { initializePostgres } = await import("./initialize");

afterAll(restoreLeaves);

describe("initializePostgres", () => {
  test("creates indexes only after the migration has added the columns they cover", async () => {
    await initializePostgres();

    const added = statements.findIndex((s) =>
      s.startsWith("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS auth_sid"),
    );
    const committed = statements.indexOf("COMMIT");
    const indexes = statements
      .map((s, i) => [s, i] as const)
      .filter(([s]) => s.startsWith("CREATE INDEX"));

    expect(added).toBeGreaterThan(-1);
    expect(committed).toBeGreaterThan(added);
    expect(indexes.map(([s]) => s)).toContain(
      "CREATE INDEX IF NOT EXISTS idx_sessions_auth_sid ON sessions(auth_sid)",
    );
    expect(indexes.filter(([, i]) => i < committed)).toEqual([]);
  });
});
