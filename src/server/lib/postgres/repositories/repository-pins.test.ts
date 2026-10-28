// Behavior pins for the two repository modules with raw-SQL carve-outs
// around the Table model — api_keys.ts and rejected-categories.ts.
// The happy paths are already covered by their existing test files; this
// file pins the failure / edge semantics a migration (pg -> Bun's native
// SQL client) must preserve:
//
// - api_keys.createApiKey: expires_at defaults to NULL in the inserted
//   values; the generated hash/prefix keep their shapes (64-hex SHA-256,
//   "bk_" prefix).
// - api_keys.listApiKeys: the projection is explicit and must never name
//   key_hash; rows are newest-first and scoped to unrevoked keys.
// - api_keys.verifyApiKey: lookup is by key_hash with a LIMIT; a failed
//   last_used_at touch must not fail the verification (best-effort,
//   fire-and-forget, swallowed).
// - rejected-categories.addRejectedCategory: an empty result maps to
//   null (not a crash on rows[0]).
// - rejected-categories.migrateRejectedCategoriesOnPendingPosted: a
//   ROLLBACK failure must not mask the original error (swallowed,
//   original rethrown); the same-id case short-circuits with no query.
// - rejected-categories.getRejectedCategoriesForTransactions: an empty
//   id list issues no query.
//
// CI has no Postgres service, so these run against the shared createFakeSql
// stub (see scripts/test-helpers.ts). rejected-categories.ts imports pool
// from "server" — the existing rejected-categories.test.ts proves that
// resolves under bun test; the same import style is used here.
import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";
import { createHash } from "crypto";

const { driver, mockUnsafe, mockReservedUnsafe, resetSqlMocks } = createFakeSql();

mock.module("../sql-driver", () => driver);

const apiKeys = await import("./api_keys");
const rejected = await import("./rejected-categories");

afterAll(restoreLeaves);

beforeEach(() => {
  resetSqlMocks();
});

const keyRow = (overrides: Record<string, unknown> = {}) => ({
  key_id: "k-1",
  user_id: "u-1",
  name: "cli",
  key_hash: createHash("sha256").update("bk_secret").digest("hex"),
  key_prefix: "bk_secr",
  scopes: ["read"],
  expires_at: null,
  last_used_at: null,
  revoked_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated: null,
  ...overrides,
});

const lastPoolCall = () => {
  const [sql, values] = mockUnsafe.mock.calls.at(-1) as [string, unknown[]];
  return { sql, values };
};

const user = { user_id: "u-1" } as never;

describe("api_keys edge semantics", () => {
  test("createApiKey defaults expires_at to NULL in the inserted values", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [keyRow()], rowCount: 1 });
    const created = await apiKeys.createApiKey({ user_id: "u-1", name: "cli", scopes: ["read"] });
    expect(created.key_id).toBe("k-1");
    expect(created.prefix.startsWith("bk_")).toBe(true);
    const { sql, values } = lastPoolCall();
    expect(sql).toContain("INSERT INTO api_keys");
    expect(sql).toContain("RETURNING key_id");
    expect(values[0]).toBe("u-1");
    expect(values[1]).toBe("cli");
    expect(values[2]).toMatch(/^[0-9a-f]{64}$/);
    expect(String(values[3]).startsWith("bk_")).toBe(true);
    expect(values[4]).toEqual(["read"]);
    expect(values[5]).toBeNull();
  });

  test("listApiKeys projects every visible column except key_hash, unrevoked, newest first", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [keyRow()], rowCount: 1 });
    await apiKeys.listApiKeys("u-1");
    const { sql, values } = lastPoolCall();
    const flat = sql.replace(/\s+/g, " ");
    expect(flat).toContain(
      "SELECT key_id, user_id, name, key_prefix, scopes, created_at, last_used_at, revoked_at, expires_at FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC",
    );
    expect(sql).not.toContain("key_hash");
    expect(values).toEqual(["u-1"]);
  });

  test("verifyApiKey looks up by key_hash with a LIMIT", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [keyRow()], rowCount: 1 });
    // The touch UPDATE is issued after the lookup; script it to succeed so
    // only the lookup shape is asserted here.
    mockUnsafe.mockResolvedValueOnce({ rows: [keyRow()], rowCount: 1 });
    await apiKeys.verifyApiKey("bk_secret");
    const [sql, values] = mockUnsafe.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("key_hash = $1");
    expect(sql).toContain("LIMIT $2");
    expect(values).toEqual([createHash("sha256").update("bk_secret").digest("hex"), 1]);
  });

  test("verifyApiKey still resolves when the last_used_at touch fails", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [keyRow()], rowCount: 1 });
    mockUnsafe.mockRejectedValueOnce(new Error("touch failed"));
    const out = await apiKeys.verifyApiKey("bk_secret");
    // Verification succeeds; the touch is best-effort and its failure is
    // swallowed, not surfaced to the caller.
    expect(out).not.toBeNull();
    expect(out!.key_id).toBe("k-1");
  });
});

describe("rejected-categories edge semantics", () => {
  test("addRejectedCategory maps an empty result to null", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await rejected.addRejectedCategory(user, "t-1", "food")).toBeNull();
  });

  test("migrateRejectedCategoriesOnPendingPosted: a ROLLBACK failure is swallowed and the original error wins", async () => {
    const original = new Error("insert failed");
    mockReservedUnsafe.mockImplementation(async (sql: string) => {
      if (String(sql).includes("INSERT INTO")) throw original;
      if (String(sql) === "ROLLBACK") throw new Error("rollback failed");
      return { rows: [], rowCount: 0 };
    });
    await expect(
      rejected.migrateRejectedCategoriesOnPendingPosted("t-old", "t-new"),
    ).rejects.toBe(original);
    const statements = mockReservedUnsafe.mock.calls.map((c) => String(c[0]).trim());
    expect(statements[0]).toBe("BEGIN");
    expect(statements.some((s) => s.startsWith("INSERT INTO"))).toBe(true);
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });

  test("migrateRejectedCategoriesOnPendingPosted with the same id copies nothing without a transaction", async () => {
    expect(await rejected.migrateRejectedCategoriesOnPendingPosted("t-1", "t-1")).toBe(0);
    expect(mockReservedUnsafe).not.toHaveBeenCalled();
  });

  test("getRejectedCategoriesForTransactions with no ids issues no query", async () => {
    expect(await rejected.getRejectedCategoriesForTransactions(user, [])).toEqual([]);
    expect(mockUnsafe).not.toHaveBeenCalled();
  });
});
