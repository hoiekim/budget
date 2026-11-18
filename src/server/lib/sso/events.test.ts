import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";
import type { AuthEvent } from "server/lib/auth-client";

const ALICE_ID = "u-alice";

const { driver, mockUnsafe, resetSqlMocks } = createFakeSql(async (sql: string, values?: unknown[]) => {
  if (sql.startsWith("SELECT * FROM users WHERE auth_sub = $1") && values?.[0] === "usr_alice") {
    const alice = {
      user_id: ALICE_ID,
      username: "alice",
      password: null,
      email: null,
      expiry: null,
      token: null,
      auth_sub: "usr_alice",
      updated: null,
      is_deleted: false,
    };
    return { rows: [alice], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
});
mock.module("../postgres/sql-driver", () => driver);

const { handleAuthEvent } = await import("./events");
const { registerSubscriber, closeAllSubscribers, subscriberCount } = await import("server/lib/realtime");

afterAll(() => {
  closeAllSubscribers();
  restoreLeaves();
});

beforeEach(() => {
  resetSqlMocks();
  closeAllSubscribers();
});

/** Opens a fake event stream; returns whether it has been closed. */
const openStream = (userId: string, authSid?: string) => {
  let closed = false;
  registerSubscriber(userId, { send: () => {}, close: () => (closed = true), authSid });
  return () => closed;
};

const deletes = () =>
  mockUnsafe.mock.calls
    .filter(([sql]) => String(sql).startsWith("DELETE"))
    .map(([sql, values]) => [sql, values]);

const event = (type: string, fields: Partial<AuthEvent> = {}): AuthEvent => ({
  type,
  jti: "evt_1",
  ...fields,
});

describe("handleAuthEvent", () => {
  test("session.ended deletes that sign-in's sessions and closes their streams only", async () => {
    const ended = openStream(ALICE_ID, "ses_1");
    const otherSignIn = openStream(ALICE_ID, "ses_2");
    const passwordSession = openStream(ALICE_ID);

    await handleAuthEvent(event("session.ended", { sid: "ses_1" }));

    expect(deletes()).toEqual([["DELETE FROM sessions WHERE auth_sid = $1 RETURNING session_id", ["ses_1"]]]);
    expect([ended(), otherSignIn(), passwordSession()]).toEqual([true, false, false]);
    expect(subscriberCount(ALICE_ID)).toBe(2);
  });

  test.each([
    ["user.disabled", {}],
    ["user.deleted", {}],
    ["access.changed", { role: null }],
  ])("%s deletes every session of the user and closes all their streams", async (type, fields) => {
    const sso = openStream(ALICE_ID, "ses_1");
    const local = openStream(ALICE_ID);
    const bob = openStream("u-bob", "ses_9");

    await handleAuthEvent(event(type, { sub: "usr_alice", ...fields }));

    expect(deletes()).toEqual([
      ["DELETE FROM sessions WHERE user_user_id = $1 RETURNING session_id", [ALICE_ID]],
    ]);
    expect([sso(), local(), bob()]).toEqual([true, true, false]);
    expect(subscriberCount(ALICE_ID)).toBe(0);
  });

  test("user.deleted keeps the user's data: sessions are all it deletes", async () => {
    await handleAuthEvent(event("user.deleted", { sub: "usr_alice" }));
    const writes = mockUnsafe.mock.calls.filter(([sql]) => !String(sql).startsWith("SELECT"));
    expect(writes.map(([sql]) => String(sql).split(" WHERE")[0])).toEqual(["DELETE FROM sessions"]);
  });

  test("a new role is still access, so access.changed to a role changes nothing", async () => {
    const stream = openStream(ALICE_ID, "ses_1");
    await handleAuthEvent(event("access.changed", { sub: "usr_alice", role: "admin" }));
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(stream()).toBe(false);
  });

  test("an event about someone with no user here deletes nothing", async () => {
    await handleAuthEvent(event("user.disabled", { sub: "usr_stranger" }));
    expect(deletes()).toEqual([]);
  });

  test.each([
    event("credential.revoked", { sub: "usr_alice", id: "key_1" }),
    event("invite.accepted", { sub: "usr_alice", invite: "inv_1" }),
    event("something.new"),
  ])("$type is acknowledged and ignored", async (ignored) => {
    const stream = openStream(ALICE_ID, "ses_1");
    await handleAuthEvent(ignored);
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(stream()).toBe(false);
  });

  test("a repeated delivery is harmless", async () => {
    await handleAuthEvent(event("user.disabled", { sub: "usr_alice" }));
    await handleAuthEvent(event("user.disabled", { sub: "usr_alice" }));
    expect(deletes()).toHaveLength(2);
  });
});
