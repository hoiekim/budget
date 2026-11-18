import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";
import { SsoError } from "common";

interface UserRow {
  user_id: string;
  username: string;
  password: string | null;
  email: null;
  expiry: null;
  token: null;
  auth_sub: string | null;
  updated: null;
  is_deleted: boolean;
}

let users: UserRow[] = [];
let nextId = 1;
/** Runs just before a write reaches the table, to stand in for a concurrent sign-in. */
let beforeWrite: () => void = () => {};

const userRow = (username: string, overrides: Partial<UserRow> = {}): UserRow => ({
  user_id: `u-${nextId++}`,
  username,
  password: "$2b$10$hash",
  email: null,
  expiry: null,
  token: null,
  auth_sub: null,
  updated: null,
  is_deleted: false,
  ...overrides,
});

const result = (rows: object[]) => ({ rows, rowCount: rows.length });

/** The users table, honoring the predicates the repository's statements carry. */
const fakeUsersTable = async (sql: string, values: unknown[] = []) => {
  const live = users.filter((u) => !u.is_deleted);
  if (sql.startsWith("SELECT * FROM users WHERE auth_sub = $1")) {
    return result(live.filter((u) => u.auth_sub === values[0]).slice(0, 1));
  }
  if (sql.startsWith("SELECT * FROM users WHERE username = $1")) {
    return result(live.filter((u) => u.username === values[0]).slice(0, 1));
  }
  if (sql.startsWith("UPDATE users SET")) {
    beforeWrite();
    expect(sql).toContain("auth_sub IS NULL");
    const [authSub, userId] = values;
    const row = live.find((u) => u.user_id === userId && u.auth_sub === null);
    if (!row) return result([]);
    if (users.some((u) => u.auth_sub === authSub)) throw new Error("duplicate key value");
    row.auth_sub = authSub as string;
    return result([{ user_id: row.user_id }]);
  }
  if (sql.startsWith("INSERT INTO users")) {
    beforeWrite();
    expect(sql).toContain("ON CONFLICT DO NOTHING");
    const [username, authSub] = values as string[];
    if (users.some((u) => u.username === username || u.auth_sub === authSub)) return result([]);
    const row = userRow(username, { password: null, auth_sub: authSub });
    users.push(row);
    return result([{ user_id: row.user_id, username }]);
  }
  throw new Error(`unexpected statement: ${sql}`);
};

const { driver, resetSqlMocks } = createFakeSql(fakeUsersTable);
mock.module("../postgres/sql-driver", () => driver);

const { findOrCreateSsoUser } = await import("./users");

afterAll(restoreLeaves);

beforeEach(() => {
  resetSqlMocks();
  nextId = 1;
  beforeWrite = () => {};
  users = [userRow("admin"), userRow("demo")];
});

const ALICE = { sub: "usr_alice", username: "alice" };
const byName = (username: string) => users.find((u) => u.username === username);

describe("findOrCreateSsoUser", () => {
  test("a user already linked to the subject is that user, whatever the links say", async () => {
    users.push(userRow("old-name", { auth_sub: "usr_alice" }));
    const found = await findOrCreateSsoUser(ALICE, new Map([["alice", "admin"]]));
    expect(found).toEqual({ user: { user_id: byName("old-name")!.user_id, username: "old-name" } });
    expect(byName("admin")!.auth_sub).toBeNull();
  });

  test("AUTH_LINK_USERS links the local account to the subject on first sign-in", async () => {
    const found = await findOrCreateSsoUser(ALICE, new Map([["alice", "admin"]]));
    expect(found).toEqual({ user: { user_id: byName("admin")!.user_id, username: "admin" } });
    expect(byName("admin")!.auth_sub).toBe("usr_alice");
    expect(byName("alice")).toBeUndefined();
  });

  test("a new person gets a new user with no password, named by the token", async () => {
    const found = await findOrCreateSsoUser(ALICE, new Map());
    const alice = byName("alice")!;
    expect(found).toEqual({ user: { user_id: alice.user_id, username: "alice" } });
    expect(alice.auth_sub).toBe("usr_alice");
    expect(alice.password).toBeNull();
  });

  test.each(["admin", "demo"])(
    "a username taken by the unlinked local account %s is refused, and that account is untouched",
    async (username) => {
      const found = await findOrCreateSsoUser({ sub: "usr_x", username }, new Map());
      expect(found).toEqual({ error: SsoError.AccountExists });
      expect(byName(username)!.auth_sub).toBeNull();
      expect(users).toHaveLength(2);
    },
  );

  test("a link to an account that does not exist falls through to a new user", async () => {
    const found = await findOrCreateSsoUser(ALICE, new Map([["alice", "nobody"]]));
    expect(found).toEqual({ user: { user_id: byName("alice")!.user_id, username: "alice" } });
  });

  test("a link to an account already linked to someone else does not take it over", async () => {
    byName("admin")!.auth_sub = "usr_bob";
    const found = await findOrCreateSsoUser(ALICE, new Map([["alice", "admin"]]));
    expect(found).toEqual({ user: { user_id: byName("alice")!.user_id, username: "alice" } });
    expect(byName("admin")!.auth_sub).toBe("usr_bob");
  });

  test("a concurrent first sign-in that created the user first wins, and this one uses it", async () => {
    beforeWrite = () => {
      if (!byName("alice")) users.push(userRow("alice", { password: null, auth_sub: "usr_alice" }));
    };
    const found = await findOrCreateSsoUser(ALICE, new Map());
    expect(found).toEqual({ user: { user_id: byName("alice")!.user_id, username: "alice" } });
    expect(users.filter((u) => u.auth_sub === "usr_alice")).toHaveLength(1);
  });

  test("a concurrent first sign-in that linked the account first wins, and this one uses it", async () => {
    beforeWrite = () => {
      byName("admin")!.auth_sub = "usr_alice";
    };
    const found = await findOrCreateSsoUser(ALICE, new Map([["alice", "admin"]]));
    expect(found).toEqual({ user: { user_id: byName("admin")!.user_id, username: "admin" } });
    expect(byName("alice")).toBeUndefined();
  });
});
