import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ADMIN_PASSWORD, DEMO_PASSWORD, createUser, startStack, type ApiClient, type Stack } from "../harness";

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.stop());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SERVER_ERROR = { status: "error", message: "Internal server error" };
const SESSION_CLEARED = "session_id=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict";

const alarmsFor = (route: string) =>
  stack.upstream.discord.alarms().filter((alarm) => alarm.title === `🚨 Budget Server Error: Route Error: ${route}`);

/** Runs `body` while the database refuses to delete any session row. */
const whileSessionsCannotBeDeleted = async (body: () => Promise<void>): Promise<void> => {
  await stack.db.query(
    "CREATE OR REPLACE FUNCTION conformance_refuse_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused by test'; END $$",
  );
  await stack.db.query(
    "CREATE TRIGGER conformance_refuse_session_delete BEFORE DELETE ON sessions FOR EACH ROW EXECUTE FUNCTION conformance_refuse_row()",
  );
  try {
    await body();
  } finally {
    await stack.db.query("DROP TRIGGER conformance_refuse_session_delete ON sessions");
  }
};

/** A client whose requests all come from `ip`, so its login rate limit is its own. */
const from = (ip: string): ApiClient => {
  const client = stack.anonymous();
  const request = client.request.bind(client);
  client.request = ((method: string, path: string, options = {}) =>
    request(method, path, { ...options, headers: { "X-Real-IP": ip, ...options.headers } })) as ApiClient["request"];
  return client;
};

describe("GET /login", () => {
  test("tells an anonymous caller nobody is signed in, and how to sign in", async () => {
    const result = await stack.anonymous().get("/login");
    expect(result.status).toBe(200);
    expect(result.json).toEqual({
      status: "success",
      body: { app: { version: "6" }, sso: { enabled: false, localLogin: true } },
      message: "Not logged in.",
    });
    expect(result.setCookies).toEqual([]);
  });

  test("names the signed-in user and refreshes the session cookie", async () => {
    const client = await from("10.1.0.1").login("admin", ADMIN_PASSWORD);
    const sid = client.cookies.get("session_id");
    const result = await client.get("/login");
    expect(result.json).toEqual({
      status: "success",
      body: {
        user: { user_id: await stack.userId("admin"), username: "admin" },
        app: { version: "6" },
        sso: { enabled: false, localLogin: true },
      },
    });
    expect(result.setCookies).toEqual([`session_id=${sid}; Max-Age=604800; Path=/; HttpOnly; SameSite=Strict`]);
  });
});

describe("POST /login", () => {
  const cases: [string, unknown, string][] = [
    ["a JSON null body", null, "Request body is required"],
    ["an array body", [], "Request body must be an object"],
    ["a string body", "admin", "Request body must be an object"],
    ["a number body", 5, "Request body must be an object"],
    ["no username", { password: "x" }, "Missing required field: username"],
    ["a null username", { username: null, password: "x" }, "Missing required field: username"],
    ["a numeric username", { username: 5, password: "x" }, "Field username must be a string"],
    ["an object username", { username: {}, password: "x" }, "Field username must be a string"],
    ["no password", { username: "admin" }, "Missing required field: password"],
    ["a null password", { username: "admin", password: null }, "Missing required field: password"],
    ["a boolean password", { username: "admin", password: true }, "Field password must be a string"],
  ];
  for (const [name, body, message] of cases) {
    test(`refuses ${name}`, async () => {
      const result = await from("10.1.1.1").post("/login", body);
      expect(result.status).toBe(200);
      expect(result.json).toEqual({ status: "failed", message });
      expect(result.setCookies).toEqual([]);
    });
  }

  test("refuses a body that is not JSON, or not labeled as JSON", async () => {
    const client = from("10.1.1.2");
    const notJson = await client.request("POST", "/login", {
      rawBody: "{bad",
      headers: { "Content-Type": "application/json" },
    });
    expect(notJson.json).toEqual({ status: "failed", message: "Request body is required" });
    const unlabeled = await client.request("POST", "/login", {
      rawBody: JSON.stringify({ username: "admin", password: ADMIN_PASSWORD }),
      headers: { "Content-Type": "text/plain" },
    });
    expect(unlabeled.json).toEqual({ status: "failed", message: "Request body is required" });
    const none = await client.request("POST", "/login");
    expect(none.json).toEqual({ status: "failed", message: "Request body is required" });
  });

  test("accepts a JSON content type with parameters, and a body with a byte-order mark", async () => {
    const client = from("10.1.1.3");
    const result = await client.request("POST", "/login", {
      rawBody: "﻿" + JSON.stringify({ username: "admin", password: ADMIN_PASSWORD }),
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
    expect(result.json.status).toBe("success");
  });

  test("signs in with the right password and starts a session", async () => {
    const client = from("10.1.2.1");
    const result = await client.post<{ user_id: string; username: string }>("/login", {
      username: "admin",
      password: ADMIN_PASSWORD,
    });
    expect(result.status).toBe(200);
    expect(result.json).toEqual({
      status: "success",
      body: { user_id: await stack.userId("admin"), username: "admin" },
    });
    expect(result.setCookies).toHaveLength(1);
    const match = /^session_id=([^;]+); Max-Age=604800; Path=\/; HttpOnly; SameSite=Strict$/.exec(result.setCookies[0]);
    expect(match).not.toBeNull();
    const sid = match![1];
    expect(sid).toMatch(UUID);

    const rows = await stack.db.rows("sessions", { session_id: sid });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.user_user_id).toBe(await stack.userId("admin"));
    expect(row.user_username).toBe("admin");
    expect(Number(row.cookie_original_max_age)).toBe(604800000);
    expect(Number(row.cookie_max_age)).toBe(604800000);
    expect(row.cookie_signed).toBeNull();
    expect(row.cookie_http_only).toBe(true);
    expect(row.cookie_path).toBe("/");
    expect(row.cookie_domain).toBeNull();
    expect(row.cookie_secure).toBe(false);
    expect(row.cookie_same_site).toBe("strict");
    expect(row.auth_sid).toBeNull();
    expect(row.auth_refresh_token).toBeNull();
    expect(row.auth_recheck_at).toBeNull();
    const expires = (row.cookie_expires as Date).getTime();
    expect(Math.abs(expires - (Date.now() + 604800000))).toBeLessThan(60_000);
  });

  test("signs the demo user in with its own password", async () => {
    const result = await from("10.1.2.2").post("/login", { username: "demo", password: DEMO_PASSWORD });
    expect(result.json).toEqual({ status: "success", body: { user_id: await stack.userId("demo"), username: "demo" } });
  });

  test("answers a wrong password and an unknown user alike", async () => {
    const client = from("10.1.2.3");
    const wrong = await client.post("/login", { username: "admin", password: "not-it" });
    const unknown = await client.post("/login", { username: "nobody-here", password: "not-it" });
    const empty = await client.post("/login", { username: "", password: "" });
    for (const result of [wrong, unknown, empty]) {
      expect(result.status).toBe(200);
      expect(result.json).toEqual({ status: "failed", message: "Invalid username or password." });
      expect(result.setCookies).toEqual([]);
    }
  });

  test("is case-sensitive about the username and exact about the password", async () => {
    const client = from("10.1.2.4");
    expect((await client.post("/login", { username: "Admin", password: ADMIN_PASSWORD })).json.status).toBe("failed");
    expect((await client.post("/login", { username: "admin", password: ` ${ADMIN_PASSWORD}` })).json.status).toBe("failed");
    expect((await client.post("/login", { username: "admin ", password: ADMIN_PASSWORD })).json.status).toBe("failed");
  });

  test("refuses a user who has no password and a deleted user", async () => {
    await createUser(stack, "sso-only", { password: null });
    const emptied = await createUser(stack, "emptied");
    await stack.db.query("UPDATE users SET password = '' WHERE user_id = $1", [emptied.user_id]);
    const deleted = await createUser(stack, "gone");
    await stack.db.query("UPDATE users SET is_deleted = TRUE WHERE user_id = $1", [deleted.user_id]);
    const client = from("10.1.2.5");
    for (const [username, password] of [["sso-only", ""], ["sso-only", "x"], ["emptied", ""], ["gone", deleted.password]]) {
      const result = await client.post("/login", { username, password });
      expect(result.json).toEqual({ status: "failed", message: "Invalid username or password." });
    }
  });

  test("fails as a server error on a stored password that is not a readable hash", async () => {
    const stored: [string, string][] = [
      ["plain", "plaintext"],
      ["cut-short", "$2b$10$short"],
      ["weak-cost", (await Bun.password.hash("pw", { algorithm: "bcrypt", cost: 4 })).replace("$04$", "$03$")],
    ];
    for (const [username, hash] of stored) {
      const user = await createUser(stack, `unreadable-${username}`);
      await stack.db.query("UPDATE users SET password = $2 WHERE user_id = $1", [user.user_id, hash]);
      const result = await from(`10.1.2.5${stored.findIndex(([u]) => u === username)}`).post("/login", {
        username: user.username,
        password: "pw",
      });
      expect(result.status).toBe(500);
      expect(result.json).toEqual({ status: "error", message: "Internal server error" });
    }
    await stack.waitFor(() => stack.upstream.discord.alarms().length >= 1, { what: "the route error alarm" });
    const alarm = stack.upstream.discord.alarms()[0];
    expect(alarm.title).toBe("🚨 Budget Server Error: Route Error: POST /login");
    expect(alarm.color).toBe(0xff0000);
    expect(alarm.description.startsWith("**Error:** ")).toBe(true);
    // One alarm a minute per source: the later failures on the same route stay quiet.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(stack.upstream.discord.alarms().filter((a) => a.title.endsWith("POST /login"))).toHaveLength(1);
  });

  test("reads the other hash formats the password store accepts", async () => {
    const formats: [string, string][] = [
      ["2a", (await Bun.password.hash("pw-2a", { algorithm: "bcrypt", cost: 5 })).replace("$2b$", "$2a$")],
      ["2y", (await Bun.password.hash("pw-2y", { algorithm: "bcrypt", cost: 5 })).replace("$2b$", "$2y$")],
      ["argon2id", await Bun.password.hash("pw-argon2id", { algorithm: "argon2id", memoryCost: 64, timeCost: 1 })],
      ["argon2i", await Bun.password.hash("pw-argon2i", { algorithm: "argon2i", memoryCost: 64, timeCost: 1 })],
      ["argon2d", await Bun.password.hash("pw-argon2d", { algorithm: "argon2d", memoryCost: 64, timeCost: 1 })],
    ];
    const client = from("10.1.2.7");
    for (const [name, hash] of formats) {
      const user = await createUser(stack, `format-${name}`);
      await stack.db.query("UPDATE users SET password = $2 WHERE user_id = $1", [user.user_id, hash]);
      expect((await client.post("/login", { username: user.username, password: `pw-${name}` })).json.status).toBe("success");
      expect((await client.post("/login", { username: user.username, password: `pw-${name}x` })).json.status).toBe("failed");
    }
  });

  test("counts every byte of a password longer than bcrypt's 72", async () => {
    const long = "p".repeat(100);
    const user = await createUser(stack, "long-password", { password: long });
    const client = from("10.1.2.8");
    expect((await client.post("/login", { username: user.username, password: long })).json.status).toBe("success");
    expect((await client.post("/login", { username: user.username, password: "p".repeat(99) })).json.status).toBe("failed");
    expect((await client.post("/login", { username: user.username, password: "p".repeat(72) })).json.status).toBe("failed");
  });

  test("signs in a user whose password was hashed at another bcrypt cost, with unicode in both fields", async () => {
    const user = await createUser(stack, "zoë", { password: "pässwörd-日本語-🔐" });
    const result = await from("10.1.2.6").post("/login", { username: user.username, password: user.password });
    expect(result.json).toEqual({ status: "success", body: { user_id: user.user_id, username: "zoë" } });
  });

  test("replaces the session a signed-in caller already had", async () => {
    const client = from("10.1.3.1");
    await client.login("admin", ADMIN_PASSWORD);
    const first = client.cookies.get("session_id")!;
    await client.login("demo", DEMO_PASSWORD);
    const second = client.cookies.get("session_id")!;
    expect(second).not.toBe(first);
    expect(await stack.db.rows("sessions", { session_id: first })).toHaveLength(0);
    const who = await client.get<{ user: { username: string } }>("/login");
    expect(who.body.user.username).toBe("demo");
  });

  test("never adopts a session id the caller made up", async () => {
    const client = from("10.1.3.2");
    client.cookies.set("session_id", "attacker-chosen");
    const result = await client.post("/login", { username: "admin", password: ADMIN_PASSWORD });
    expect(result.json.status).toBe("success");
    expect(client.cookies.get("session_id")).toMatch(UUID);
    expect(await stack.db.rows("sessions", { session_id: "attacker-chosen" })).toHaveLength(0);
  });

  test("a failed sign-in keeps the session the caller had", async () => {
    const client = from("10.1.3.3");
    await client.login("admin", ADMIN_PASSWORD);
    const sid = client.cookies.get("session_id");
    const result = await client.post("/login", { username: "admin", password: "wrong" });
    expect(result.json.status).toBe("failed");
    expect(result.setCookies).toEqual([`session_id=${sid}; Max-Age=604800; Path=/; HttpOnly; SameSite=Strict`]);
    expect((await client.get<{ user: { username: string } }>("/login")).body.user.username).toBe("admin");
  });

  describe("rate limit", () => {
    test("sheds the sixth attempt after five failures from one address, even with the right password", async () => {
      const client = from("10.2.0.1");
      for (let i = 0; i < 5; i++) {
        const result = await client.post("/login", { username: "admin", password: `wrong-${i}` });
        expect(result.status).toBe(200);
        expect(result.json.message).toBe("Invalid username or password.");
      }
      const shed = await client.post("/login", { username: "admin", password: ADMIN_PASSWORD });
      expect(shed.status).toBe(429);
      expect(shed.json).toEqual({ status: "failed", message: "Too many login attempts, try again later" });
      expect(shed.setCookies).toEqual([]);
      // Shed before the body is read: a body that would fail validation gets the same answer.
      const shedInvalid = await client.post("/login", []);
      expect(shedInvalid.status).toBe(429);
      // Other verbs on the path are not limited.
      expect((await client.get("/login")).status).toBe(200);
      // Another address is unaffected.
      expect((await from("10.2.0.2").post("/login", { username: "admin", password: ADMIN_PASSWORD })).status).toBe(200);
    });

    test("does not charge validation failures or successes", async () => {
      const client = from("10.2.1.1");
      for (let i = 0; i < 8; i++) {
        expect((await client.post("/login", { username: "admin" })).status).toBe(200);
      }
      for (let i = 0; i < 8; i++) {
        expect((await client.post("/login", { username: "admin", password: ADMIN_PASSWORD })).json.status).toBe("success");
      }
      for (let i = 0; i < 4; i++) {
        expect((await client.post("/login", { username: "admin", password: "wrong" })).status).toBe(200);
      }
      // Four failures so far: a success still gets through and leaves them counted.
      expect((await client.post("/login", { username: "admin", password: ADMIN_PASSWORD })).json.status).toBe("success");
      expect((await client.post("/login", { username: "admin", password: "wrong" })).status).toBe(200);
      expect((await client.post("/login", { username: "admin", password: ADMIN_PASSWORD })).status).toBe(429);
    });

    test("keys on X-Real-IP first, then the first X-Forwarded-For entry", async () => {
      const fail = (headers: Record<string, string>) =>
        stack.anonymous().post("/login", { username: "admin", password: "wrong" }, { headers });
      for (let i = 0; i < 5; i++) await fail({ "X-Forwarded-For": "10.2.2.1, 10.9.9.9" });
      expect((await fail({ "X-Forwarded-For": "10.2.2.1" })).status).toBe(429);
      expect((await fail({ "X-Forwarded-For": " 10.2.2.1 ,10.8.8.8" })).status).toBe(429);
      expect((await fail({ "X-Forwarded-For": "10.9.9.9, 10.2.2.1" })).status).toBe(200);
      // X-Real-IP wins over X-Forwarded-For.
      expect((await fail({ "X-Real-IP": "10.2.2.2", "X-Forwarded-For": "10.2.2.1" })).status).toBe(200);
      for (let i = 0; i < 4; i++) await fail({ "X-Real-IP": "10.2.2.2" });
      expect((await fail({ "X-Real-IP": "10.2.2.2", "X-Forwarded-For": "10.7.7.7" })).status).toBe(429);
    });

    test("forgets its counts when the server restarts", async () => {
      const client = from("10.2.3.1");
      for (let i = 0; i < 5; i++) await client.post("/login", { username: "admin", password: "wrong" });
      expect((await client.post("/login", { username: "admin", password: "wrong" })).status).toBe(429);
      await stack.restart();
      expect((await client.post("/login", { username: "admin", password: ADMIN_PASSWORD })).json.status).toBe("success");
    });
  });
});

describe("DELETE /login", () => {
  test("ends the session and clears the cookie", async () => {
    const client = await from("10.3.0.1").login("admin", ADMIN_PASSWORD);
    const sid = client.cookies.get("session_id")!;
    const result = await client.delete("/login");
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ status: "success" });
    expect(result.setCookies).toEqual(["session_id=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict"]);
    await stack.waitFor(async () => (await stack.db.rows("sessions", { session_id: sid })).length === 0);
    // The old cookie no longer signs anyone in.
    const replay = await stack.anonymous().get("/login", { headers: { Cookie: `session_id=${sid}` } });
    expect(replay.json.message).toBe("Not logged in.");
  });

  test("answers an anonymous caller the same way", async () => {
    const result = await stack.anonymous().delete("/login");
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ status: "success" });
    expect(result.setCookies).toEqual(["session_id=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict"]);
  });

  test("answers 500 and raises an alarm when the session row cannot be deleted, clearing the cookie all the same", async () => {
    const client = await from("10.3.0.2").login("admin", ADMIN_PASSWORD);
    const sid = client.cookies.get("session_id")!;
    await whileSessionsCannotBeDeleted(async () => {
      const result = await client.delete("/login");
      expect(result.status).toBe(500);
      expect(result.json).toEqual(SERVER_ERROR);
      expect(result.setCookies).toEqual([SESSION_CLEARED]);
      await stack.waitFor(() => alarmsFor("DELETE /login").length > 0, { what: "the DELETE /login alarm" });
    });
    // The row the delete was refused is still there.
    expect(await stack.db.rows("sessions", { session_id: sid })).toHaveLength(1);
  });
});

describe("POST /login, replacing a session", () => {
  test("answers 500 and raises an alarm when the session it replaces cannot be deleted, and signs nobody in", async () => {
    const client = await from("10.3.1.1").login("admin", ADMIN_PASSWORD);
    const sid = client.cookies.get("session_id")!;
    await whileSessionsCannotBeDeleted(async () => {
      const result = await client.post("/login", { username: "admin", password: ADMIN_PASSWORD });
      expect(result.status).toBe(500);
      expect(result.json).toEqual(SERVER_ERROR);
      expect(result.setCookies).toEqual([]);
      await stack.waitFor(() => alarmsFor("POST /login").length > 0, { what: "the POST /login alarm" });
    });
    expect(await stack.db.rows("sessions", { session_id: sid })).toHaveLength(1);
  });
});
