/**
 * `Authorization: Bearer <API key>` on the one route that declares a scope,
 * `POST /suggest-category` (`transactions:suggest`). The assertions here are
 * about who the request is taken to be from: refused before the route (401,
 * "Not authenticated.") or let through to it. What the route then does with
 * its body belongs to its own test file.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { createUser, createUserClient, startStack, type ApiClient, type ApiResult, type SeededUser, type Stack } from "../harness";

// Tests here start, restart and wait on real server processes: give each the suite's 30 seconds
// rather than the runner's default of five.
setDefaultTimeout(30_000);

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.stop());

const SCOPE = "transactions:suggest";
const NOT_AUTHENTICATED = { status: "failed", message: "Not authenticated." };
/** A body the route answers without touching anything. */
const NOTHING_TO_SUGGEST = { suggestions: [] };

let users = 0;
const newUser = () => createUserClient(stack, `bearer-user-${++users}`);

/** A key issued through the API, as a person would get one. */
const issueKey = async (client: ApiClient, body: Record<string, unknown> = {}): Promise<{ key_id: string; plaintext: string }> => {
  const result = await client.post<{ key_id: string; plaintext: string }>("/api-keys", { name: "bearer test", scopes: [SCOPE], ...body });
  expect(result.json.status).toBe("success");
  return result.body;
};

/** A key written straight to the store, for the rows no endpoint creates. */
const seedKey = async (
  user: SeededUser,
  row: { scopes?: string[]; revoked_at?: Date; expires_at?: Date } = {},
): Promise<{ key_id: string; plaintext: string }> => {
  const plaintext = `bk_${randomBytes(32).toString("base64url")}`;
  const stored = await stack.db.insert<{ key_id: string }>("api_keys", {
    user_id: user.user_id,
    name: "seeded",
    key_hash: createHash("sha256").update(plaintext).digest("hex"),
    key_prefix: plaintext.slice(0, 11),
    scopes: row.scopes ?? [SCOPE],
    revoked_at: row.revoked_at,
    expires_at: row.expires_at,
  });
  return { key_id: stored.key_id, plaintext };
};

const suggest = (authorization: string | undefined, client: ApiClient = stack.anonymous()): Promise<ApiResult> =>
  client.post("/suggest-category", NOTHING_TO_SUGGEST, { headers: authorization === undefined ? {} : { Authorization: authorization } });

/** Refused before the route, with no cookie handed out. */
const expectRefused = (result: ApiResult) => {
  expect(result.status).toBe(401);
  expect(result.json).toEqual(NOT_AUTHENTICATED);
  expect(result.setCookies).toEqual([]);
};

/** Let through to the route. */
const expectReached = (result: ApiResult) => {
  expect(result.status).toBe(200);
  expect(result.json.message).not.toBe(NOT_AUTHENTICATED.message);
  expect(result.json.status).toBeDefined();
};

const lastUsedAt = async (key_id: string): Promise<Date | null> =>
  ((await stack.db.one("SELECT last_used_at FROM api_keys WHERE key_id = $1", [key_id]))?.last_used_at as Date | null) ?? null;

describe("a key that authenticates", () => {
  test("reaches the route as its owner, with no session and no cookie", async () => {
    const { user, client } = await newUser();
    const key = await issueKey(client);
    const sessionsBefore = await stack.db.rows("sessions", { user_user_id: user.user_id });

    const result = await suggest(`Bearer ${key.plaintext}`);
    expectReached(result);
    expect(result.setCookies).toEqual([]);
    // Bearer auth is stateless: the request leaves no session behind.
    expect(await stack.db.rows("sessions", { user_user_id: user.user_id })).toHaveLength(sessionsBefore.length);
  });

  test("has its last use recorded", async () => {
    const { client } = await newUser();
    const key = await issueKey(client);
    expect(await lastUsedAt(key.key_id)).toBeNull();
    const before = Date.now();
    expectReached(await suggest(`Bearer ${key.plaintext}`));
    const used = await stack.waitFor(() => lastUsedAt(key.key_id), { what: "last_used_at to be written" });
    expect(used?.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(used?.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    // And the list shows it.
    const listed = await client.get<{ api_keys: { key_id: string; last_used_at: string | null }[] }>("/api-keys");
    expect(listed.body.api_keys.find((k) => k.key_id === key.key_id)?.last_used_at).toBe(used?.toISOString());
  });

  test("keeps working request after request, and for each of a user's keys", async () => {
    const { client } = await newUser();
    const first = await issueKey(client);
    const second = await issueKey(client);
    for (const key of [first, second, first]) expectReached(await suggest(`Bearer ${key.plaintext}`));
  });

  test("works until its expiry, when it has one", async () => {
    const { client } = await newUser();
    const key = await issueKey(client, { expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    expectReached(await suggest(`Bearer ${key.plaintext}`));
  });

  test("works when the scope is one of several the key carries", async () => {
    const { user } = await newUser();
    const key = await seedKey(user, { scopes: ["transactions:read", SCOPE, "other"] });
    expectReached(await suggest(`Bearer ${key.plaintext}`));
  });

  test("is read with white space around it trimmed", async () => {
    const { client } = await newUser();
    const key = await issueKey(client);
    expectReached(await suggest(`Bearer   ${key.plaintext}`));
    expectReached(await suggest(`Bearer \t${key.plaintext}`));
  });

  test("answers the route's own refusals, not the gate's, once it is through", async () => {
    const { client } = await newUser();
    const key = await issueKey(client);
    const result = await stack.anonymous().post("/suggest-category", {}, { headers: { Authorization: `Bearer ${key.plaintext}` } });
    expectReached(result);
    expect(result.setCookies).toEqual([]);
  });
});

describe("a key that does not authenticate", () => {
  test("no credentials at all", async () => {
    expectRefused(await suggest(undefined));
  });

  test("a key whose scopes do not include the route's", async () => {
    const { user } = await newUser();
    for (const scopes of [["transactions:read"], [], ["transactions"], ["transactions:suggest:all"], ["TRANSACTIONS:SUGGEST"], ["*"]]) {
      const key = await seedKey(user, { scopes });
      expectRefused(await suggest(`Bearer ${key.plaintext}`));
    }
  });

  test("a revoked key, from the moment it is revoked", async () => {
    const { client } = await newUser();
    const key = await issueKey(client);
    expectReached(await suggest(`Bearer ${key.plaintext}`));
    expect((await client.delete("/api-keys", { query: { key_id: key.key_id } })).json.status).toBe("success");
    expectRefused(await suggest(`Bearer ${key.plaintext}`));
  });

  test("an expired key", async () => {
    const { user } = await newUser();
    const expired = await seedKey(user, { expires_at: new Date(Date.now() - 1000) });
    expectRefused(await suggest(`Bearer ${expired.plaintext}`));
    const longExpired = await seedKey(user, { expires_at: new Date(Date.UTC(2001, 0, 1)) });
    expectRefused(await suggest(`Bearer ${longExpired.plaintext}`));
    // A refused key's use is not recorded.
    expect(await lastUsedAt(expired.key_id)).toBeNull();
  });

  test("a key that was never issued", async () => {
    expectRefused(await suggest(`Bearer bk_${randomBytes(32).toString("base64url")}`));
    expectRefused(await suggest("Bearer bk_"));
    expectRefused(await suggest("Bearer bk_short"));
  });

  test("a real key altered, cut short, or without its prefix", async () => {
    const { client } = await newUser();
    const key = await issueKey(client);
    const flipped = key.plaintext.slice(0, -1) + (key.plaintext.endsWith("A") ? "B" : "A");
    for (const candidate of [
      flipped,
      key.plaintext.slice(0, -1),
      `${key.plaintext}A`,
      key.plaintext.slice(3),
      key.plaintext.toUpperCase(),
      `BK_${key.plaintext.slice(3)}`,
      `${key.plaintext} extra`,
      `x${key.plaintext}`,
    ]) {
      expectRefused(await suggest(`Bearer ${candidate}`));
    }
    // None of that harmed the key.
    expectReached(await suggest(`Bearer ${key.plaintext}`));
  });

  test("the key's hash or its prefix instead of the key", async () => {
    const { client } = await newUser();
    const key = await issueKey(client);
    const row = await stack.db.one("SELECT key_hash, key_prefix FROM api_keys WHERE key_id = $1", [key.key_id]);
    expectRefused(await suggest(`Bearer ${row?.key_hash}`));
    expectRefused(await suggest(`Bearer ${row?.key_prefix}`));
    expectRefused(await suggest(`Bearer ${key.key_id}`));
  });

  test("a header that is not `Bearer <key>`", async () => {
    const { client } = await newUser();
    const key = await issueKey(client);
    for (const header of [
      "Bearer",
      "Bearer ",
      "Bearer    ",
      key.plaintext,
      `bearer ${key.plaintext}`,
      `BEARER ${key.plaintext}`,
      `Bearer\t${key.plaintext}`,
      `Bearer:${key.plaintext}`,
      `Token ${key.plaintext}`,
      `Basic ${Buffer.from(`user:${key.plaintext}`).toString("base64")}`,
      `Basic ${key.plaintext}`,
      `Bearer Bearer ${key.plaintext}`,
      `Bearer "${key.plaintext}"`,
    ]) {
      expectRefused(await suggest(header));
    }
    expect(await lastUsedAt(key.key_id)).toBeNull();
  });

  test("the key in a cookie, a query parameter or the body instead of the header", async () => {
    const { client } = await newUser();
    const key = await issueKey(client);
    const anonymous = stack.anonymous();
    expectRefused(await anonymous.post("/suggest-category", NOTHING_TO_SUGGEST, { headers: { Cookie: `session_id=${key.plaintext}` } }));
    expectRefused(await anonymous.post("/suggest-category", NOTHING_TO_SUGGEST, { query: { api_key: key.plaintext, access_token: key.plaintext } }));
    expectRefused(await anonymous.post("/suggest-category", { ...NOTHING_TO_SUGGEST, api_key: key.plaintext }));
    expectRefused(await anonymous.post("/suggest-category", NOTHING_TO_SUGGEST, { headers: { "X-Api-Key": key.plaintext } }));
  });

  test("the key of a user who was deleted", async () => {
    const user = await createUser(stack, "bearer-deleted");
    const key = await seedKey(user);
    expectReached(await suggest(`Bearer ${key.plaintext}`));
    await stack.db.query("UPDATE users SET is_deleted = TRUE WHERE user_id = $1", [user.user_id]);
    expectRefused(await suggest(`Bearer ${key.plaintext}`));
    // Restored, the same key works again: nothing about the key itself changed.
    await stack.db.query("UPDATE users SET is_deleted = FALSE WHERE user_id = $1", [user.user_id]);
    expectReached(await suggest(`Bearer ${key.plaintext}`));
  });

  test("the key of a user whose row is gone takes the key with it", async () => {
    const user = await createUser(stack, "bearer-erased");
    const key = await seedKey(user);
    await stack.db.query("DELETE FROM users WHERE user_id = $1", [user.user_id]);
    expect(await stack.db.rows("api_keys", { key_id: key.key_id })).toEqual([]);
    expectRefused(await suggest(`Bearer ${key.plaintext}`));
  });
});

describe("a key next to a cookie session", () => {
  test("the session wins: the request is the signed-in user's, and the key is never looked at", async () => {
    const owner = await newUser();
    const key = await issueKey(owner.client);
    const signedIn = await newUser();
    const sid = signedIn.client.cookies.get("session_id");

    const result = await suggest(`Bearer ${key.plaintext}`, signedIn.client);
    expectReached(result);
    // The session cookie is refreshed, as on any request of a signed-in user.
    expect(result.setCookies).toEqual([`session_id=${sid}; Max-Age=604800; Path=/; HttpOnly; SameSite=Strict`]);
    // Let a touch that should not happen have its chance to.
    expectReached(await suggest(`Bearer ${key.plaintext}`, signedIn.client));
    expect(await lastUsedAt(key.key_id)).toBeNull();
  });

  test("a signed-in user is not held back by a bad key", async () => {
    const { user, client } = await newUser();
    const revoked = await seedKey(user, { revoked_at: new Date() });
    for (const header of ["Bearer bk_never-issued", `Bearer ${revoked.plaintext}`, "Basic nonsense", "Bearer"]) {
      const result = await suggest(header, client);
      expectReached(result);
      expect(result.setCookies).toHaveLength(1);
    }
  });

  test("a cookie that names no session leaves the key to authenticate", async () => {
    const { client } = await newUser();
    const key = await issueKey(client);
    const stale = stack.anonymous();
    const result = await stale.post("/suggest-category", NOTHING_TO_SUGGEST, {
      headers: { Authorization: `Bearer ${key.plaintext}`, Cookie: "session_id=00000000-0000-4000-8000-000000000000" },
    });
    expectReached(result);
    expect(result.setCookies).toEqual([]);

    const signedOut = await newUser();
    const theirKey = await issueKey(signedOut.client);
    const oldCookie = signedOut.client.cookieHeader();
    await signedOut.client.delete("/login");
    const after = await stack.anonymous().post("/suggest-category", NOTHING_TO_SUGGEST, {
      headers: { Authorization: `Bearer ${theirKey.plaintext}`, Cookie: oldCookie },
    });
    expectReached(after);
    expect(after.setCookies).toEqual([]);
  });
});

describe("a key on a route that declares no scope", () => {
  test("is not credentials at all: the route answers as to an anonymous caller", async () => {
    const { client } = await newUser();
    const key = await issueKey(client);
    const headers = { Authorization: `Bearer ${key.plaintext}` };
    const anonymous = stack.anonymous();

    expectRefused(await anonymous.get("/api-keys", { headers }));
    expectRefused(await anonymous.post("/api-keys", { name: "more", scopes: [SCOPE] }, { headers }));
    expectRefused(await anonymous.delete("/api-keys", { headers, query: { key_id: key.key_id } }));
    expectRefused(await anonymous.get("/events", { headers }));
    // The scoped path under another verb is another route, or none.
    expectRefused(await anonymous.get("/suggest-category", { headers }));
    expectRefused(await anonymous.delete("/suggest-category", { headers }));
    expectRefused(await anonymous.post("/suggest-category/", NOTHING_TO_SUGGEST, { headers }));
    expectRefused(await anonymous.post("/no-such-route", NOTHING_TO_SUGGEST, { headers }));

    // A public route answers, but not as the key's owner.
    const who = await anonymous.get("/login", { headers });
    expect(who.status).toBe(200);
    expect(who.json.message).toBe("Not logged in.");
    expect(who.setCookies).toEqual([]);

    // None of it counted as a use of the key, and the key still lists once.
    expect(await lastUsedAt(key.key_id)).toBeNull();
    expect((await client.get<{ api_keys: unknown[] }>("/api-keys")).body.api_keys).toHaveLength(1);
  });
});
