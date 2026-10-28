/**
 * Tests for PostgresSessionStore.get — the read-path expiry enforcement
 * (hoiekim/budget#824). The hourly purge sweep is hygiene, not the security
 * boundary: a row whose cookie_expires has passed must not authenticate,
 * and is hard-deleted on the way out.
 */

import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";

const { driver, mockUnsafe, resetSqlMocks } = createFakeSql();

mock.module("../sql-driver", () => driver);

const { PostgresSessionStore } = await import("./session");

afterAll(restoreLeaves);

beforeEach(() => {
  resetSqlMocks();
});

/** Raw sessions-table row matching SessionModel's schema. */
const sessionRow = (overrides: Record<string, unknown> = {}) => ({
  session_id: "s-1",
  user_user_id: "u-1",
  user_username: "test",
  cookie_original_max_age: null,
  cookie_max_age: null,
  cookie_signed: null,
  cookie_expires: new Date(Date.now() + 3600_000).toISOString(),
  cookie_http_only: null,
  cookie_path: null,
  cookie_domain: null,
  cookie_secure: null,
  cookie_same_site: null,
  created_at: null,
  updated: null,
  ...overrides,
});

const store = new PostgresSessionStore();
// The constructor arms the hourly purge timer; unref it so the test process
// is not held open by the handle.
(
  store as unknown as { cleanupInterval: { unref(): void } }
).cleanupInterval.unref();

describe("PostgresSessionStore.get", () => {
  test("returns null for an unknown sid", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await store.get("s-nope")).toBeNull();
  });

  test("returns the session for a row whose expiry is in the future", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [sessionRow()], rowCount: 1 });
    const data = await store.get("s-1");
    expect(data?.user.user_id).toBe("u-1");
    const deletes = mockUnsafe.mock.calls.filter(([sql]) =>
      String(sql).startsWith("DELETE"),
    );
    expect(deletes).toHaveLength(0);
  });

  test("an expired row does not authenticate and is hard-deleted on the way out", async () => {
    mockUnsafe.mockImplementation(async (sql: unknown) => {
      if (String(sql).startsWith("DELETE")) return { rows: [], rowCount: 1 };
      return {
        rows: [sessionRow({ cookie_expires: new Date(Date.now() - 1000).toISOString() })],
        rowCount: 1,
      };
    });
    expect(await store.get("s-1")).toBeNull();
    const deletes = mockUnsafe.mock.calls.filter(([sql]) =>
      String(sql).startsWith("DELETE"),
    );
    expect(deletes).toHaveLength(1);
    expect(String(deletes[0][0])).toMatch(/sessions/);
    expect(deletes[0][1]).toEqual(["s-1"]);
  });

  test("a null cookie_expires carries no recorded expiry — the row authenticates", async () => {
    // Explicit decision: null only arises for rows written before the column
    // existed or sessions persisted without a cookie expiry; there is nothing
    // to enforce, so behavior is unchanged (the purge sweep agrees —
    // NULL <= now is never true).
    mockUnsafe.mockResolvedValueOnce({ rows: [sessionRow({ cookie_expires: null })], rowCount: 1 });
    const data = await store.get("s-1");
    expect(data?.user.user_id).toBe("u-1");
  });

  test("an unparseable cookie_expires fails closed", async () => {
    mockUnsafe.mockImplementation(async (sql: unknown) => {
      if (String(sql).startsWith("DELETE")) return { rows: [], rowCount: 1 };
      return { rows: [sessionRow({ cookie_expires: "not-a-date" })], rowCount: 1 };
    });
    expect(await store.get("s-1")).toBeNull();
    const deletes = mockUnsafe.mock.calls.filter(([sql]) =>
      String(sql).startsWith("DELETE"),
    );
    expect(deletes).toHaveLength(1);
  });
});
