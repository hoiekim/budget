/**
 * `POST /auth/events`: the identity provider's security events. A token that
 * verifies is applied: a session that ended there ends here, and a person
 * whose access ended loses their sessions, their open event streams and the
 * API keys issued to them here.
 */
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { CLIENT_ID, ISSUER, createUser, startStack, type ApiClient, type ApiResult, type RequestOptions, type Stack } from "../harness";
import { openEventStream, type EventStream } from "../harness/sse";
import { ssoSignIn } from "../harness/sso";

// Tests here start, restart and wait on real server processes: give each the suite's 30 seconds
// rather than the runner's default of five.
setDefaultTimeout(30_000);

let stack: Stack;
beforeAll(async () => {
  // Password sign-in stays on, so a person can hold both kinds of session.
  stack = await startStack({ sso: { AUTH_LOCAL_LOGIN: "true" } });
});
afterAll(() => stack.stop());

const streams: EventStream[] = [];
afterEach(async () => {
  for (const stream of streams.splice(0)) await stream.close();
});

const issuer = () => stack.upstream.issuer;
const nowS = () => Math.floor(Date.now() / 1000);
const INVALID = { status: "failed", message: "Invalid security event token." };
const SCOPE = "transactions:suggest";

const send = (token: string, options: RequestOptions = {}, client: ApiClient = stack.anonymous()): Promise<ApiResult> =>
  client.request("POST", "/auth/events", { rawBody: token, headers: { "Content-Type": "application/secevent+jwt" }, ...options });

/** Delivers one event the way the provider does. */
const deliver = (events: object, claims: object = {}): Promise<ApiResult> => send(issuer().eventToken(events, claims));

const expectAccepted = (result: ApiResult) => {
  expect(result.status).toBe(202);
  expect(result.json).toEqual({ status: "success" });
};

const expectInvalid = (result: ApiResult) => {
  expect(result.status).toBe(400);
  expect(result.json).toEqual(INVALID);
};

let people = 0;
/** A person signed in through single sign-on, on a browser of their own. */
const signedIn = async (who?: { sub: string; username: string; email?: string }, sid?: string) => {
  const n = ++people;
  const claims = { sub: who?.sub ?? `usr_event_${n}`, username: who?.username ?? `event-${n}`, sid: sid ?? `ses_event_${n}` };
  const client = stack.anonymous();
  await ssoSignIn(stack, client, { claims, idClaims: who?.email ? { email: who.email } : {} });
  const user = await stack.db.one<{ user_id: string }>("SELECT user_id FROM users WHERE auth_sub = $1", [claims.sub]);
  return { ...claims, client, user_id: (user as { user_id: string }).user_id };
};

const isSignedIn = async (client: ApiClient): Promise<boolean> =>
  (await client.get<{ user?: unknown }>("/login")).body.user !== undefined;

const sessionsOf = (user_id: string) => stack.db.rows("sessions", { user_user_id: user_id });

/** An open event stream of `client`, past its opening blocks. */
const tab = async (client: ApiClient, options: { noCompare?: boolean } = {}): Promise<EventStream> => {
  const stream = await openEventStream(client, options);
  streams.push(stream);
  expect(stream.status).toBe(200);
  await stream.next((block) => block.event === "connected");
  return stream;
};

/** A snapshot of everything an event could touch, to show one touched nothing. */
const everything = async () => ({
  sessions: await stack.db.query("SELECT session_id, auth_sid FROM sessions ORDER BY session_id"),
  keys: await stack.db.query("SELECT key_id, revoked_at FROM api_keys ORDER BY key_id"),
  users: await stack.db.query("SELECT user_id, auth_sub, is_deleted FROM users ORDER BY user_id"),
});

describe("a token that does not verify", () => {
  const jwt = (header: object, payload: object) => issuer().jwt(header, payload);
  const header = { alg: "EdDSA", typ: "secevent+jwt", kid: "k1" };
  const set = (claims: Record<string, unknown> = {}) => ({
    iss: ISSUER,
    aud: CLIENT_ID,
    iat: nowS(),
    jti: "evt_invalid",
    events: { "user.disabled": { sub: "usr_someone" } },
    ...claims,
  });

  const bodies: [string, () => string][] = [
    ["an empty body", () => ""],
    ["a blank body", () => " \n "],
    ["a body that is not a JWT", () => "user.disabled"],
    ["three segments that are not JSON", () => "aaaa.bbbb.cccc"],
    ["a JSON body", () => JSON.stringify(set())],
    ["an access token", () => issuer().accessToken()],
    ["an ID token", () => issuer().idToken()],
    ["a token with no type", () => jwt({ ...header, typ: undefined }, set())],
    ["an unsigned token", () => jwt({ ...header, alg: "none" }, set())],
    ["a token with a critical header", () => jwt({ ...header, crit: ["events"] }, set())],
    ["a token with no key id", () => jwt({ ...header, kid: undefined }, set())],
    ["a token signed by someone else's key", () => issuer().foreignKeyToken(set(), header)],
    ["a token whose payload was changed after signing", () => {
      const [h, , s] = jwt(header, set()).split(".");
      const [, p] = jwt(header, set({ events: { "user.deleted": { sub: "usr_someone" } } })).split(".");
      return `${h}.${p}.${s}`;
    }],
    ["a token from another issuer", () => jwt(header, set({ iss: "https://other.example.test" }))],
    ["a token with no issuer", () => jwt(header, set({ iss: undefined }))],
    ["a token for another audience", () => jwt(header, set({ aud: "another-app" }))],
    ["a token with no audience", () => jwt(header, set({ aud: undefined }))],
    ["a token issued in the future", () => jwt(header, set({ iat: nowS() + 120 }))],
    ["a token with no issue time", () => jwt(header, set({ iat: undefined }))],
    ["a token with no id", () => jwt(header, set({ jti: undefined }))],
    ["a token with an empty id", () => jwt(header, set({ jti: "" }))],
    ["a token whose id is a number", () => jwt(header, set({ jti: 5 }))],
    ["a token with no events", () => jwt(header, set({ events: undefined }))],
    ["a token with an empty events object", () => jwt(header, set({ events: {} }))],
    ["a token with two events", () => jwt(header, set({ events: { "user.disabled": { sub: "a" }, "user.deleted": { sub: "a" } } }))],
    ["a token whose events are a list", () => jwt(header, set({ events: [{ "user.disabled": { sub: "a" } }] }))],
    ["a token whose events are text", () => jwt(header, set({ events: "user.disabled" }))],
    ["a token whose events are null", () => jwt(header, set({ events: null }))],
    ["an event whose payload is text", () => jwt(header, set({ events: { "user.disabled": "usr_someone" } }))],
    ["an event whose payload is null", () => jwt(header, set({ events: { "user.disabled": null } }))],
    ["an event whose payload is a list", () => jwt(header, set({ events: { "user.disabled": [{ sub: "a" }] } }))],
    ["an unknown event whose payload is not an object", () => jwt(header, set({ events: { "something.new": true } }))],
    ["session.ended without sid", () => jwt(header, set({ events: { "session.ended": { sub: "usr_someone" } } }))],
    ["session.ended with a sid that is not text", () => jwt(header, set({ events: { "session.ended": { sid: 5 } } }))],
    ["user.disabled without sub", () => jwt(header, set({ events: { "user.disabled": {} } }))],
    ["user.deleted with a null sub", () => jwt(header, set({ events: { "user.deleted": { sub: null } } }))],
    ["access.changed without sub", () => jwt(header, set({ events: { "access.changed": { role: null } } }))],
    ["access.changed without role", () => jwt(header, set({ events: { "access.changed": { sub: "usr_someone" } } }))],
    ["access.changed with a role that is a number", () => jwt(header, set({ events: { "access.changed": { sub: "usr_someone", role: 1 } } }))],
    ["access.changed with a role that is false", () => jwt(header, set({ events: { "access.changed": { sub: "usr_someone", role: false } } }))],
    ["invite.accepted without invite", () => jwt(header, set({ events: { "invite.accepted": { sub: "usr_someone" } } }))],
    ["invite.accepted without sub", () => jwt(header, set({ events: { "invite.accepted": { invite: "inv_1" } } }))],
    ["credential.revoked without id", () => jwt(header, set({ events: { "credential.revoked": { sub: "usr_someone" } } }))],
    ["credential.revoked without sub", () => jwt(header, set({ events: { "credential.revoked": { id: "key_1" } } }))],
  ];
  for (const [what, body] of bodies) {
    test(`refuses ${what}`, async () => {
      const result = await send(body());
      expectInvalid(result);
      expect(result.setCookies).toEqual([]);
      expect(result.headers.get("content-type")).toBe("application/json");
    });
  }

  test("refuses a request with no body at all", async () => {
    expectInvalid(await stack.anonymous().request("POST", "/auth/events"));
    expectInvalid(await stack.anonymous().request("POST", "/auth/events", { headers: { "Content-Type": "application/secevent+jwt" } }));
  });

  test("changes nothing", async () => {
    const victim = await signedIn();
    const before = await everything();
    expectInvalid(await send(issuer().foreignKeyToken(set({ events: { "user.disabled": { sub: victim.sub } } }), header)));
    expectInvalid(await send(jwt(header, set({ aud: "another-app", events: { "session.ended": { sid: victim.sid } } }))));
    expect(await everything()).toEqual(before);
    expect(await isSignedIn(victim.client)).toBe(true);
  });
});

describe("a token that verifies", () => {
  test("is acknowledged with 202, whatever its content type", async () => {
    const token = () => issuer().eventToken({ "invite.accepted": { invite: "inv_1", sub: "usr_nobody" } });
    expectAccepted(await send(token()));
    for (const contentType of ["text/plain", "application/jwt", "application/json", "application/x-www-form-urlencoded", "application/octet-stream"]) {
      expectAccepted(await send(token(), { headers: { "Content-Type": contentType } }));
    }
    // With no content type named, the client library names one of its own.
    expectAccepted(await stack.anonymous().request("POST", "/auth/events", { rawBody: token() }));
  });

  test("is read with white space around it trimmed, and its type in any letter case", async () => {
    const token = issuer().eventToken({ "invite.accepted": { invite: "inv_1", sub: "usr_nobody" } });
    expectAccepted(await send(`\n  ${token}\r\n\t`));
    expectAccepted(await send(issuer().eventToken({ "user.disabled": { sub: "usr_nobody" } }, {}, { typ: "SecEvent+JWT" })));
  });

  test("needs no expiry, and may be old: the provider retries for as long as it takes", async () => {
    expectAccepted(await deliver({ "user.disabled": { sub: "usr_nobody" } }, { iat: nowS() - 30 * 86_400 }));
    expectAccepted(await deliver({ "user.disabled": { sub: "usr_nobody" } }, { iat: nowS() - 3600, exp: nowS() - 1800 }));
    // A moment ahead of this clock is within the leeway.
    expectAccepted(await deliver({ "user.disabled": { sub: "usr_nobody" } }, { iat: nowS() + 20 }));
    expectAccepted(await deliver({ "user.disabled": { sub: "usr_nobody" } }, { aud: ["another-app", CLIENT_ID] }));
  });

  test("of a type nobody here knows is acknowledged and ignored", async () => {
    const bystander = await signedIn();
    const before = await everything();
    for (const type of ["something.new", "session.started", "USER.DISABLED", "user.disabled ", ""]) {
      expectAccepted(await deliver({ [type]: { sub: bystander.sub, sid: bystander.sid } }));
    }
    expect(await everything()).toEqual(before);
  });

  test("about someone or something not known here changes nothing", async () => {
    const bystander = await signedIn();
    const before = await everything();
    expectAccepted(await deliver({ "session.ended": { sid: "ses_never_seen" } }));
    expectAccepted(await deliver({ "user.disabled": { sub: "usr_never_seen" } }));
    expectAccepted(await deliver({ "user.deleted": { sub: "usr_never_seen" } }));
    expectAccepted(await deliver({ "access.changed": { sub: "usr_never_seen", role: null } }));
    expect(await everything()).toEqual(before);
    expect(await isSignedIn(bystander.client)).toBe(true);
  });

  test("that needs nothing done here is acknowledged: an accepted invite, a revoked credential, a changed role", async () => {
    const person = await signedIn();
    const key = await person.client.post<{ key_id: string }>("/api-keys", { name: "kept", scopes: [SCOPE] });
    const before = await everything();
    expectAccepted(await deliver({ "invite.accepted": { invite: "inv_1", sub: person.sub } }));
    expectAccepted(await deliver({ "credential.revoked": { sub: person.sub, id: key.body.key_id } }));
    expectAccepted(await deliver({ "credential.revoked": { sub: person.sub, id: "key_at_the_provider" } }));
    // Budget has no roles of its own: a new role is still access.
    expectAccepted(await deliver({ "access.changed": { sub: person.sub, role: "viewer" } }));
    expectAccepted(await deliver({ "access.changed": { sub: person.sub, role: "" } }));
    expect(await everything()).toEqual(before);
    expect(await isSignedIn(person.client)).toBe(true);
  });
});

describe("session.ended", () => {
  test("ends the sessions of that sign-in, and only those", async () => {
    const who = { sub: "usr_two_browsers", username: "two-browsers" };
    const laptop = await signedIn(who, "ses_laptop");
    const phone = await signedIn(who, "ses_phone");
    const other = await signedIn();
    const [laptopTab, phoneTab, otherTab] = [await tab(laptop.client), await tab(phone.client), await tab(other.client)];

    expectAccepted(await deliver({ "session.ended": { sid: "ses_laptop" } }));

    // Its event stream is closed from this side, at once.
    await laptopTab.waitForEnd();
    expect(laptopTab.endedByServer).toBe(true);
    expect(await stack.db.rows("sessions", { auth_sid: "ses_laptop" })).toEqual([]);
    expect(await isSignedIn(laptop.client)).toBe(false);
    const refused = await laptop.client.get("/api-keys");
    expect(refused.status).toBe(401);

    // The same person's other sign-in and everyone else carry on.
    expect(await stack.db.rows("sessions", { auth_sid: "ses_phone" })).toHaveLength(1);
    expect(await isSignedIn(phone.client)).toBe(true);
    expect(await isSignedIn(other.client)).toBe(true);
    expect(phoneTab.ended).toBe(false);
    expect(otherTab.ended).toBe(false);

    // Delivered again, it is acknowledged again and finds nothing left to do.
    const before = await everything();
    expectAccepted(await deliver({ "session.ended": { sid: "ses_laptop" } }));
    expect(await everything()).toEqual(before);
    expect(phoneTab.ended).toBe(false);

    // The other sign-in ends the same way, when its turn comes.
    expectAccepted(await deliver({ "session.ended": { sid: "ses_phone", sub: who.sub } }));
    await phoneTab.waitForEnd();
    expect(await sessionsOf(laptop.user_id)).toEqual([]);
    expect(otherTab.ended).toBe(false);
  });

  test("ends every session that came of one sign-in at the provider", async () => {
    const who = { sub: "usr_shared_sid", username: "shared-sid" };
    const first = await signedIn(who, "ses_shared");
    const second = await signedIn(who, "ses_shared");
    expect(await stack.db.rows("sessions", { auth_sid: "ses_shared" })).toHaveLength(2);
    const [firstTab, secondTab] = [await tab(first.client), await tab(second.client)];
    expectAccepted(await deliver({ "session.ended": { sid: "ses_shared" } }));
    await firstTab.waitForEnd();
    await secondTab.waitForEnd();
    expect(await stack.db.rows("sessions", { auth_sid: "ses_shared" })).toEqual([]);
  });

  test("leaves the person's password session and API keys alone", async () => {
    const local = await createUser(stack, "event-local", { email: "event-local@example.test" });
    const password = await stack.login(local.username, local.password);
    const passwordTab = await tab(password);
    // Signing in through the provider links the account by its email.
    const sso = await signedIn({ sub: "usr_event_local", username: "event-local-at-idp", email: "event-local@example.test" }, "ses_event_local");
    expect(sso.user_id).toBe(local.user_id);
    const key = await password.post<{ key_id: string }>("/api-keys", { name: "kept", scopes: [SCOPE] });

    expectAccepted(await deliver({ "session.ended": { sid: "ses_event_local" } }));
    expect(await isSignedIn(sso.client)).toBe(false);
    expect(await isSignedIn(password)).toBe(true);
    expect(passwordTab.ended).toBe(false);
    expect((await stack.db.rows("api_keys", { key_id: key.body.key_id }))[0].revoked_at).toBeNull();
  });

  test("delivered by the session it ends does not bring that session back", async () => {
    const person = await signedIn();
    const sid = person.client.cookies.get("session_id") as string;
    // The request carries the session's own cookie, so the session is saved again as the request ends.
    const result = await send(issuer().eventToken({ "session.ended": { sid: person.sid } }), {}, person.client);
    expectAccepted(result);
    expect(await stack.db.rows("sessions", { session_id: sid })).toEqual([]);
    expect(await isSignedIn(person.client)).toBe(false);
    expect(await stack.db.rows("sessions", { session_id: sid })).toEqual([]);
  });
});

describe("the end of a person's access", () => {
  const endings: [string, (sub: string) => object][] = [
    ["user.disabled", (sub) => ({ "user.disabled": { sub } })],
    ["user.deleted", (sub) => ({ "user.deleted": { sub } })],
    ["access.changed to no role", (sub) => ({ "access.changed": { sub, role: null } })],
  ];
  for (const [what, eventOf] of endings) {
    test(`${what} ends every session of theirs, closes their event streams and revokes the keys issued here`, async () => {
      const slug = what.replace(/[^a-z]+/g, "-");
      // A local account, signed in with its password, then linked by signing in through the provider twice.
      const local = await createUser(stack, `ending-${slug}`, { email: `${slug}@example.test` });
      const password = await stack.login(local.username, local.password);
      const who = { sub: `usr_ending_${slug}`, username: `idp-${slug}`, email: `${slug}@example.test` };
      const laptop = await signedIn(who, `ses_${slug}_laptop`);
      const phone = await signedIn(who, `ses_${slug}_phone`);
      expect(laptop.user_id).toBe(local.user_id);
      expect(await sessionsOf(local.user_id)).toHaveLength(3);

      const keys = [
        (await laptop.client.post<{ key_id: string }>("/api-keys", { name: "one", scopes: [SCOPE] })).body.key_id,
        (await password.post<{ key_id: string }>("/api-keys", { name: "two", scopes: [SCOPE] })).body.key_id,
      ];
      const revokedBefore = (await password.post<{ key_id: string }>("/api-keys", { name: "old", scopes: [SCOPE] })).body.key_id;
      const longAgo = new Date(Date.UTC(2020, 0, 1));
      await stack.db.query("UPDATE api_keys SET revoked_at = $2 WHERE key_id = $1", [revokedBefore, longAgo]);

      const other = await signedIn();
      const otherKey = (await other.client.post<{ key_id: string }>("/api-keys", { name: "theirs", scopes: [SCOPE] })).body.key_id;
      const tabs = [await tab(password), await tab(laptop.client), await tab(phone.client)];
      const otherTab = await tab(other.client);

      const before = Date.now();
      expectAccepted(await deliver(eventOf(who.sub)));

      for (const stream of tabs) {
        await stream.waitForEnd();
        expect(stream.endedByServer).toBe(true);
      }
      expect(await sessionsOf(local.user_id)).toEqual([]);
      for (const client of [password, laptop.client, phone.client]) expect(await isSignedIn(client)).toBe(false);

      const revoked = await stack.db.query<{ key_id: string; revoked_at: Date }>(
        "SELECT key_id, revoked_at FROM api_keys WHERE user_id = $1 ORDER BY created_at",
        [local.user_id],
      );
      expect(revoked.map((row) => row.key_id)).toEqual([...keys, revokedBefore]);
      for (const row of revoked.slice(0, 2)) {
        expect(row.revoked_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
        expect(row.revoked_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
      }
      // A key revoked before keeps the time it was revoked.
      expect(revoked[2].revoked_at.getTime()).toBe(longAgo.getTime());

      // The account itself is kept, link, password, email and all: only its access ended.
      expect(await stack.db.one("SELECT username, auth_sub, email, is_deleted FROM users WHERE user_id = $1", [local.user_id])).toEqual({
        username: local.username,
        auth_sub: who.sub,
        email: `${slug}@example.test`,
        is_deleted: false,
      });

      // Nobody else is touched.
      expect(await isSignedIn(other.client)).toBe(true);
      expect(otherTab.ended).toBe(false);
      expect((await stack.db.rows("api_keys", { key_id: otherKey }))[0].revoked_at).toBeNull();

      // Delivered again: acknowledged, and the revocation times stand.
      expectAccepted(await deliver(eventOf(who.sub)));
      const again = await stack.db.query<{ revoked_at: Date }>(
        "SELECT revoked_at FROM api_keys WHERE user_id = $1 ORDER BY created_at",
        [local.user_id],
      );
      expect(again.map((row) => row.revoked_at.getTime())).toEqual(revoked.map((row) => row.revoked_at.getTime()));

      // Access given back at the provider signs them in again; the keys stay revoked.
      const back = await signedIn(who, `ses_${slug}_back`);
      expect(back.user_id).toBe(local.user_id);
      expect(await isSignedIn(back.client)).toBe(true);
      expect((await back.client.get<{ api_keys: unknown[] }>("/api-keys")).body.api_keys).toEqual([]);
      // Their password does not sign them in while the provider governs the account.
      const refused = await stack.anonymous().post("/login", { username: local.username, password: local.password }, { headers: { "X-Real-IP": "10.60.0.1" } });
      expect(refused.json).toEqual({ status: "failed", message: "Invalid username or password." });
    });
  }

  test("delivered by a session of the person themselves does not bring the session back", async () => {
    const person = await signedIn();
    const sid = person.client.cookies.get("session_id") as string;
    expectAccepted(await send(issuer().eventToken({ "user.disabled": { sub: person.sub } }), {}, person.client));
    expect(await stack.db.rows("sessions", { session_id: sid })).toEqual([]);
    expect(await isSignedIn(person.client)).toBe(false);
  });

  test("a subject that is someone's username or user id here, but nobody's subject, ends nothing", async () => {
    const person = await signedIn();
    const before = await everything();
    expectAccepted(await deliver({ "user.disabled": { sub: person.username } }));
    expectAccepted(await deliver({ "user.disabled": { sub: person.user_id } }));
    expectAccepted(await deliver({ "user.disabled": { sub: person.sub.toUpperCase() } }));
    expect(await everything()).toEqual(before);
  });
});

describe("a session that ends with no event delivered here to say so", () => {
  test("has its open event stream closed within a minute, by the stream's own re-read of its session", async () => {
    const who = { sub: "usr_watched", username: "watched" };
    const ended = await signedIn(who, "ses_watched_ended");
    const kept = await signedIn(who, "ses_watched_kept");
    // Not compared across servers: how many keepalive comments fit in before the close is a matter of milliseconds.
    const [endedTab, keptTab] = [await tab(ended.client, { noCompare: true }), await tab(kept.client, { noCompare: true })];
    const opened = Date.now();
    // Deleted behind the server's back, as another copy of the app would on an event delivered to it.
    await stack.db.query("DELETE FROM sessions WHERE session_id = $1", [ended.client.cookies.get("session_id")]);

    await endedTab.waitForEnd({ timeoutMs: 75_000 });
    expect(endedTab.endedByServer).toBe(true);
    const waited = Date.now() - opened;
    expect(waited).toBeGreaterThanOrEqual(55_000);
    expect(waited).toBeLessThan(70_000);
    // The same person's other session was re-read too, and found in place.
    expect(keptTab.ended).toBe(false);
    expect(await isSignedIn(kept.client)).toBe(true);
  }, 90_000);
});

describe("the route", () => {
  test("takes POST from anyone, and nothing else", async () => {
    for (const method of ["GET", "DELETE", "PUT"]) {
      const result = await stack.anonymous().request(method, "/auth/events");
      expect(result.status).toBe(401);
      expect(result.json).toEqual({ status: "failed", message: "Not authenticated." });
    }
    const person = await signedIn();
    const result = await person.client.get("/auth/events");
    expect(result.status).toBe(404);
    expect(result.json).toEqual({ status: "error", message: "Not Found" });
  });

  test("an event type named like a built-in of the language fails as a server error, and raises the alarm", async () => {
    const result = await deliver({ constructor: { sub: "usr_nobody" } });
    expect(result.status).toBe(500);
    expect(result.json).toEqual({ status: "error", message: "Internal server error" });
    const alarm = await stack.waitFor(
      () => stack.upstream.discord.alarms().find((a) => a.title === "🚨 Budget Server Error: Route Error: POST /auth/events"),
      { what: "the route error alarm" },
    );
    expect(alarm?.description).toBe("**Error:** {} is not iterable");
    for (const type of ["toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString", "__proto__", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"]) {
      expect((await deliver({ [type]: {} })).status).toBe(500);
    }
    // Only a payload that is an object gets that far.
    expectInvalid(await deliver({ constructor: "usr_nobody" }));
  });
});
