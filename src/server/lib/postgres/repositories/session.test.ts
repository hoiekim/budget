/**
 * Tests for PostgresSessionStore.get — the read-path expiry enforcement
 * (hoiekim/budget#824). The hourly purge sweep is hygiene, not the security
 * boundary: a row whose cookie_expires has passed must not authenticate,
 * and is hard-deleted on the way out.
 */

import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";
import type { SessionData } from "../models/session";

const { driver, mockUnsafe, resetSqlMocks } = createFakeSql();

mock.module("../sql-driver", () => driver);

const { PostgresSessionStore, purgeSessions } = await import("./session");

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

  test("round-trips user and cookie.expires through fromSessionData → toJSON", async () => {
    const expires = new Date(Date.now() + 3600_000);
    mockUnsafe.mockResolvedValueOnce({ rows: [sessionRow({ cookie_expires: expires.toISOString() })], rowCount: 1 });
    const data = await store.get("s-1");
    expect(data?.user).toEqual({ user_id: "u-1", username: "test" });
    expect(data?.cookie.expires).toBeInstanceOf(Date);
    expect(data?.cookie.expires?.getTime()).toBe(expires.getTime());
  });
});

describe("PostgresSessionStore.set", () => {
  test("emits one INSERT … ON CONFLICT whose update list excludes session_id", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const session: SessionData = {
      user: { user_id: "u-1", username: "test" },
      cookie: { expires: new Date(Date.now() + 3600_000), httpOnly: true, path: "/" },
    };
    await store.set("s-1", session);

    expect(mockUnsafe).toHaveBeenCalledTimes(1);
    const [sql, values] = mockUnsafe.mock.calls[0];
    expect(String(sql)).toMatch(/^INSERT INTO sessions/i);
    expect(String(sql)).toMatch(/ON CONFLICT \(session_id\) DO UPDATE SET/i);
    // The SET clause is the mutant's target: including session_id there would
    // rewrite the key on conflict, and dropping a column would silently stop
    // persisting it — so both directions are pinned, not just the statement.
    const setClause = String(sql).split("DO UPDATE SET")[1].split(" RETURNING")[0];
    expect(setClause).not.toMatch(/session_id\s*=/);
    expect(setClause).toMatch(/user_user_id = EXCLUDED\.user_user_id/);
    expect(setClause).toMatch(/user_username = EXCLUDED\.user_username/);
    expect(setClause).toMatch(/cookie_expires = EXCLUDED\.cookie_expires/);
    expect(values).toContain("s-1");
    expect(values).toContain("u-1");
  });
});

describe("PostgresSessionStore.destroy", () => {
  test("emits one DELETE for the session id", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [{ session_id: "s-1" }], rowCount: 1 });
    await store.destroy("s-1");

    expect(mockUnsafe).toHaveBeenCalledTimes(1);
    const [sql, values] = mockUnsafe.mock.calls[0];
    expect(String(sql)).toBe("DELETE FROM sessions WHERE session_id = $1 RETURNING session_id");
    expect(values).toEqual(["s-1"]);
  });
});

describe("purgeSessions", () => {
  test("deletes rows whose cookie_expires has passed — <=, not >=", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 3 });
    const before = Date.now();
    expect(await purgeSessions()).toBe(3);

    expect(mockUnsafe).toHaveBeenCalledTimes(1);
    const [sql, values] = mockUnsafe.mock.calls[0];
    expect(String(sql)).toBe("DELETE FROM sessions WHERE cookie_expires <= $1 RETURNING session_id");
    // Flipping the comparator to >= would purge every LIVE session instead
    // of every expired one — the exact mutant this pins.
    expect(String(sql)).not.toContain(">=");
    expect(values).toHaveLength(1);
    expect(values[0]).toBeInstanceOf(Date);
    expect((values[0] as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect((values[0] as Date).getTime()).toBeLessThanOrEqual(Date.now());
  });
});
