import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";
import { SsoError } from "common";

interface UserRow {
  user_id: string;
  username: string;
  password: string | null;
  email: string | null;
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

const lower = (email: string | null) => email?.toLowerCase() ?? null;

/** Rows the statement can see: soft-deleted ones only when it does not exclude them. */
const visible = (sql: string) =>
  sql.includes("(is_deleted IS NULL OR is_deleted = FALSE)")
    ? users.filter((u) => !u.is_deleted)
    : users;

/**
 * The users table, honoring the predicates the repository's statements carry
 * and the unique username, `auth_sub` and `lower(email)` over every row.
 */
const fakeUsersTable = async (sql: string, values: unknown[] = []) => {
  if (sql.startsWith("SELECT * FROM users WHERE auth_sub = $1")) {
    return result(visible(sql).filter((u) => u.auth_sub === values[0]).slice(0, 1));
  }
  if (sql.startsWith("SELECT * FROM users WHERE username = $1")) {
    return result(visible(sql).filter((u) => u.username === values[0]).slice(0, 1));
  }
  if (sql.startsWith("SELECT * FROM users WHERE lower(email) = lower($1)")) {
    const email = lower(values[0] as string);
    return result(visible(sql).filter((u) => lower(u.email) === email).slice(0, 1));
  }
  if (sql.startsWith("UPDATE users SET")) {
    beforeWrite();
    expect(sql).toContain("auth_sub IS NULL");
    const [authSub, userId] = values;
    const row = visible(sql).find((u) => u.user_id === userId && u.auth_sub === null);
    if (!row) return result([]);
    if (users.some((u) => u.auth_sub === authSub)) throw new Error("duplicate key value");
    row.auth_sub = authSub as string;
    return result([{ user_id: row.user_id }]);
  }
  if (sql.startsWith("INSERT INTO users")) {
    beforeWrite();
    expect(sql).toContain("ON CONFLICT DO NOTHING");
    const columns = sql.match(/\(([^)]*)\)/)![1].split(", ").slice(1);
    const insert = Object.fromEntries(columns.map((column, i) => [column, values[i]]));
    const { username, auth_sub: authSub, email = null } = insert as Record<string, string>;
    const taken = users.some(
      (u) =>
        u.username === username ||
        u.auth_sub === authSub ||
        (email !== null && lower(u.email) === lower(email)),
    );
    if (taken) return result([]);
    const row = userRow(username, { password: null, auth_sub: authSub, email });
    users.push(row);
    return result([{ user_id: row.user_id, username }]);
  }
  throw new Error(`unexpected statement: ${sql}`);
};

const { driver, mockUnsafe, resetSqlMocks } = createFakeSql(fakeUsersTable);
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
const ALICE_WITH_EMAIL = { ...ALICE, email: "alice@example.com" };
const byName = (username: string) => users.find((u) => u.username === username);
const linkWrites = () =>
  mockUnsafe.mock.calls.filter(([sql]) => String(sql).startsWith("UPDATE users SET"));

describe("findOrCreateSsoUser", () => {
  test("a user already linked to the subject is that user, whatever the links and emails say", async () => {
    users.push(userRow("old-name", { auth_sub: "usr_alice" }));
    byName("demo")!.email = "alice@example.com";
    const found = await findOrCreateSsoUser(ALICE_WITH_EMAIL, new Map([["alice", "admin"]]));
    expect(found).toEqual({ user: { user_id: byName("old-name")!.user_id, username: "old-name" } });
    expect(byName("admin")!.auth_sub).toBeNull();
    expect(byName("demo")!.auth_sub).toBeNull();
  });

  test("AUTH_LINK_USERS links the local account to the subject on first sign-in", async () => {
    const found = await findOrCreateSsoUser(ALICE, new Map([["alice", "admin"]]));
    expect(found).toEqual({ user: { user_id: byName("admin")!.user_id, username: "admin" } });
    expect(byName("admin")!.auth_sub).toBe("usr_alice");
    expect(byName("alice")).toBeUndefined();
  });

  test("AUTH_LINK_USERS is followed before the email", async () => {
    byName("demo")!.email = "alice@example.com";
    const found = await findOrCreateSsoUser(ALICE_WITH_EMAIL, new Map([["alice", "admin"]]));
    expect(found).toEqual({ user: { user_id: byName("admin")!.user_id, username: "admin" } });
    expect(byName("demo")!.auth_sub).toBeNull();
  });

  test("the unlinked account with the token's email, in any letter case, is linked", async () => {
    byName("admin")!.email = "Alice@Example.COM";
    const found = await findOrCreateSsoUser(
      { ...ALICE, email: "alice@EXAMPLE.com" },
      new Map(),
    );
    expect(found).toEqual({ user: { user_id: byName("admin")!.user_id, username: "admin" } });
    expect(byName("admin")!.auth_sub).toBe("usr_alice");
    expect(byName("alice")).toBeUndefined();
  });

  test("an AUTH_LINK_USERS account that can't be linked falls through to the email", async () => {
    byName("admin")!.auth_sub = "usr_bob";
    byName("demo")!.email = "alice@example.com";
    const found = await findOrCreateSsoUser(ALICE_WITH_EMAIL, new Map([["alice", "admin"]]));
    expect(found).toEqual({ user: { user_id: byName("demo")!.user_id, username: "demo" } });
    expect(byName("demo")!.auth_sub).toBe("usr_alice");
  });

  test("the token's email is trimmed before it is matched", async () => {
    byName("admin")!.email = "alice@example.com";
    const found = await findOrCreateSsoUser(
      { ...ALICE, email: "  alice@example.com " },
      new Map(),
    );
    expect(found).toEqual({ user: { user_id: byName("admin")!.user_id, username: "admin" } });
  });

  test("an account with the email that is linked to someone else is not taken over", async () => {
    byName("admin")!.email = "alice@example.com";
    byName("admin")!.auth_sub = "usr_bob";
    const found = await findOrCreateSsoUser(ALICE_WITH_EMAIL, new Map());
    const alice = byName("alice")!;
    expect(found).toEqual({ user: { user_id: alice.user_id, username: "alice" } });
    expect(byName("admin")!.auth_sub).toBe("usr_bob");
    expect(alice.email).toBeNull();
    expect(linkWrites()).toEqual([]);
  });

  test("a deleted account with the email is not linked, and keeps the email to itself", async () => {
    byName("admin")!.email = "alice@example.com";
    byName("admin")!.is_deleted = true;
    const found = await findOrCreateSsoUser(ALICE_WITH_EMAIL, new Map());
    const alice = byName("alice")!;
    expect(found).toEqual({ user: { user_id: alice.user_id, username: "alice" } });
    expect(byName("admin")!.auth_sub).toBeNull();
    expect(alice.email).toBeNull();
    expect(linkWrites()).toEqual([]);
  });

  test("a new person gets a new user with no password, named by the token, with its email", async () => {
    byName("admin")!.email = "admin@example.com";
    const found = await findOrCreateSsoUser(ALICE_WITH_EMAIL, new Map());
    const alice = byName("alice")!;
    expect(found).toEqual({ user: { user_id: alice.user_id, username: "alice" } });
    expect(alice.auth_sub).toBe("usr_alice");
    expect(alice.password).toBeNull();
    expect(alice.email).toBe("alice@example.com");
    expect(byName("admin")!.auth_sub).toBeNull();
  });

  test.each([
    ["no email", undefined],
    ["a null email", null],
    ["an empty email", ""],
    ["a blank email", "   "],
    ["an email that is not a string", 42],
  ] as [string, unknown][])(
    "a token with %s gets a new user with no email, and links no account by email",
    async (_, email) => {
      byName("admin")!.email = "";
      const found = await findOrCreateSsoUser({ ...ALICE, email: email as string }, new Map());
      const alice = byName("alice")!;
      expect(found).toEqual({ user: { user_id: alice.user_id, username: "alice" } });
      expect(alice.email).toBeNull();
      expect(byName("admin")!.auth_sub).toBeNull();
    },
  );

  test.each(["admin", "demo"])(
    "a username taken by the unlinked local account %s is refused, and that account is untouched",
    async (username) => {
      const found = await findOrCreateSsoUser(
        { sub: "usr_x", username, email: "x@example.com" },
        new Map(),
      );
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

  test("a concurrent first sign-in that linked the email's account first wins, and this one uses it", async () => {
    byName("admin")!.email = "alice@example.com";
    beforeWrite = () => {
      byName("admin")!.auth_sub = "usr_alice";
    };
    const found = await findOrCreateSsoUser(ALICE_WITH_EMAIL, new Map());
    expect(found).toEqual({ user: { user_id: byName("admin")!.user_id, username: "admin" } });
    expect(byName("alice")).toBeUndefined();
  });
});
