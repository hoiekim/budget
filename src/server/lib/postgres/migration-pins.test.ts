// Behavior pins for runMigrations / migrateTable in ./migration — the
// advisory-lock + transaction discipline a migration (pg -> Bun's native
// SQL client) must preserve:
//
// - one session-level advisory lock (key 6453604) brackets the whole run,
//   acquired before BEGIN and released before the client returns to the
//   pool, even on failure;
// - fatal schema errors roll back TWICE (once in the fatal branch, once
//   in the catch) — a quirk, pinned so the migration author notices it
//   rather than "fixing" it silently;
// - a thrown error always propagates after ROLLBACK + unlock + release;
// - an unlock failure is swallowed (a broken connection must not mask
//   the original outcome);
// - migrateTable (no transaction) still releases its client.
//
// The pure helpers (parseColumnDefinition, normalizeDbType,
// typesCompatible, buildAddColumnSql) are already pinned in
// migration.test.ts and are not repeated here.
//
// CI has no Postgres service, so these run against a recording fake
// client. The lock/transaction statements are produced by the repo's own
// code; the stub only returns scripted information_schema rows.
import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";

const { driver, mockReservedUnsafe, mockReserve, mockRelease } = createFakeSql();

mock.module("./sql-driver", () => driver);

const { runMigrations, migrateTable } = await import("./migration");

afterAll(restoreLeaves);

beforeEach(() => {
  mockReservedUnsafe.mockClear();
  mockRelease.mockClear();
  mockReserve.mockClear();
  mockReservedUnsafe.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
});

const statements = () => mockReservedUnsafe.mock.calls.map((c) => c[0] as string);
const LOCK = "SELECT pg_advisory_lock($1)";
const UNLOCK = "SELECT pg_advisory_unlock($1)";
const LOCK_KEY = 6453604;

const infoRow = (overrides: Record<string, unknown> = {}) => ({
  column_name: "a",
  data_type: "text",
  udt_name: "text",
  is_nullable: "YES",
  column_default: null,
  ...overrides,
});

describe("runMigrations lock + transaction discipline", () => {
  test("happy path: lock, BEGIN, info query, COMMIT, unlock, release", async () => {
    await runMigrations([{ name: "t", schema: { a: "TEXT" } }]);
    const calls = mockReservedUnsafe.mock.calls;
    expect(statements()).toEqual([
      LOCK,
      "BEGIN",
      expect.stringContaining("information_schema.columns"),
      "COMMIT",
      UNLOCK,
    ]);
    expect(calls[0][1]).toEqual([LOCK_KEY]);
    expect(calls[2][1]).toEqual(["t"]);
    expect(calls[4][1]).toEqual([LOCK_KEY]);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  test("a missing column issues the inferred-default ALTER, then commits", async () => {
    mockReservedUnsafe.mockImplementation(async (sql: string) => {
      if (String(sql).includes("information_schema.columns")) {
        return { rows: [infoRow()], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    await runMigrations([{ name: "t", schema: { a: "TEXT", b: "INTEGER NOT NULL" } }]);
    const alter = statements().find((s) => s.startsWith("ALTER TABLE"));
    expect(alter).toBe(
      "ALTER TABLE t ADD COLUMN IF NOT EXISTS b INTEGER DEFAULT 0 NOT NULL",
    );
    expect(statements()).toContain("COMMIT");
    expect(statements()).not.toContain("ROLLBACK");
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  test("a type mismatch is fatal: ROLLBACK twice, unlock, release, exact error", async () => {
    mockReservedUnsafe.mockImplementation(async (sql: string) => {
      if (String(sql).includes("information_schema.columns")) {
        return {
          rows: [infoRow({ data_type: "integer", udt_name: "int4" })],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    await expect(runMigrations([{ name: "t", schema: { a: "TEXT" } }])).rejects.toThrow(
      "Schema migration failed:\nt: Type mismatch for a: schema expects TEXT, database has INTEGER",
    );
    // The fatal branch rolls back, throws, and the catch rolls back again.
    // That double ROLLBACK is current behavior — pinned, not endorsed.
    expect(statements()).toEqual([
      LOCK,
      "BEGIN",
      expect.stringContaining("information_schema.columns"),
      "ROLLBACK",
      "ROLLBACK",
      UNLOCK,
    ]);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  test("a thrown query rolls back, unlocks, releases, and rethrows the original error", async () => {
    const boom = new Error("boom");
    mockReservedUnsafe.mockImplementation(async (sql: string) => {
      if (String(sql).includes("information_schema.columns")) throw boom;
      return { rows: [], rowCount: 0 };
    });
    await expect(runMigrations([{ name: "t", schema: { a: "TEXT" } }])).rejects.toBe(boom);
    expect(statements()).toEqual([
      LOCK,
      "BEGIN",
      expect.stringContaining("information_schema.columns"),
      "ROLLBACK",
      UNLOCK,
    ]);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  test("an unlock failure is swallowed and the run still resolves", async () => {
    mockReservedUnsafe.mockImplementation(async (sql: string) => {
      if (sql === UNLOCK) throw new Error("connection gone");
      return { rows: [], rowCount: 0 };
    });
    await expect(
      runMigrations([{ name: "t", schema: { a: "TEXT" } }]),
    ).resolves.toBeUndefined();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});

describe("migrateTable", () => {
  test("no transaction, and the client is always released", async () => {
    const result = await migrateTable("t", { a: "TEXT" });
    expect(result).toEqual({ table: "t", added: [], warnings: [], errors: [] });
    expect(statements()).not.toContain("BEGIN");
    expect(statements()).not.toContain("COMMIT");
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(mockReserve).toHaveBeenCalledTimes(1);
  });
});
