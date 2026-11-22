/**
 * API keys while single sign-on is on. A key budget's own store does not
 * hold is checked with the identity provider (token introspection): it
 * authenticates when the provider says it is active, its owner is linked to
 * a user here, and its scopes include the route's. Answers are remembered
 * for a minute, and dropped when the provider says the key or its owner
 * changed.
 *
 * Like `bearer.test.ts`, this is about who a request to `POST
 * /suggest-category` is taken to be from, not about what that route does.
 */
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  ISSUER_HOST,
  jsonResponse,
  startStack,
  type ApiClient,
  type ApiResult,
  type RequestOptions,
  type Stack,
} from "../harness";
import { ssoSignIn } from "../harness/sso";

// Tests here start, restart and wait on real server processes: give each the suite's 30 seconds
// rather than the runner's default of five.
setDefaultTimeout(30_000);

let stack: Stack;
let holder: { client: ApiClient; sub: string; user_id: string };
beforeAll(async () => {
  stack = await startStack({ sso: true });
  const client = stack.anonymous();
  await ssoSignIn(stack, client, { claims: { sub: "usr_keyholder", username: "keyholder", sid: "ses_keyholder" } });
  holder = { client, sub: "usr_keyholder", user_id: await stack.userId("keyholder") };
});
afterAll(() => stack.stop());
afterEach(() => {
  stack.upstream.issuer.reset();
  stack.upstream.issuer.setUnreachable(false);
});

const issuer = () => stack.upstream.issuer;
const SCOPE = "transactions:suggest";
const NOT_AUTHENTICATED = { status: "failed", message: "Not authenticated." };
const CANNOT_CHECK = { status: "failed", message: "Cannot check the API key right now. Try again later." };
const BASIC = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`;

const introspections = () => issuer().seen("/oauth/introspect");

let secrets = 0;
/** A key the provider issued: nothing budget's own store has ever seen. */
const providerKey = () => `ak_provider_${++secrets}_${crypto.randomUUID().replace(/-/g, "")}`;

/** What the provider says of an active key of the linked user, over which a test lays its own. */
const active = (extra: Record<string, unknown> = {}) => ({
  active: true,
  sub: holder.sub,
  username: "keyholder",
  role: "user",
  scope: SCOPE,
  jti: "key_default",
  ...extra,
});

const suggest = (secret: string, options: RequestOptions = {}): Promise<ApiResult> =>
  stack.anonymous().post("/suggest-category", { suggestions: [] }, {
    ...options,
    headers: { Authorization: `Bearer ${secret}`, ...options.headers },
  });

const expectReached = (result: ApiResult) => {
  expect(result.status).toBe(200);
  expect(result.json.message).not.toBe(NOT_AUTHENTICATED.message);
  expect(result.setCookies).toEqual([]);
};

const expectRefused = (result: ApiResult) => {
  expect(result.status).toBe(401);
  expect(result.json).toEqual(NOT_AUTHENTICATED);
  expect(result.setCookies).toEqual([]);
};

const expectCannotCheck = (result: ApiResult) => {
  expect(result.status).toBe(503);
  expect(result.json).toEqual(CANNOT_CHECK);
  expect(result.headers.get("content-type")).toBe("application/json");
  expect(result.headers.get("x-content-type-options")).toBe("nosniff");
  expect(result.setCookies).toEqual([]);
};

const sendEvent = (events: object): Promise<ApiResult> =>
  stack.anonymous().request("POST", "/auth/events", {
    rawBody: issuer().eventToken(events),
    headers: { "Content-Type": "application/secevent+jwt" },
  });

describe("a key the provider issued", () => {
  test("authenticates as the local user linked to its owner, when it is active and carries the scope", async () => {
    const secret = providerKey();
    issuer().state.introspect = () => jsonResponse(200, active());
    const before = introspections().length;
    expectReached(await suggest(secret, { headers: { "X-Real-IP": "203.0.113.9" } }));

    const requests = introspections().slice(before);
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].host).toBe(ISSUER_HOST);
    expect(requests[0].body).toBe(`token=${secret}`);
    expect(requests[0].headers.authorization).toBe(BASIC);
    expect(requests[0].headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(requests[0].headers.accept).toBe("application/json");
    // The caller's address goes along, for the provider's own rate limits.
    expect(requests[0].headers["x-real-ip"]).toBe("203.0.113.9");
    // Stateless, like budget's own keys: no session came of it.
    expect(await stack.db.rows("sessions", { user_user_id: holder.user_id })).toHaveLength(1);
  });

  test("is sent to the provider form-encoded, whatever characters it holds", async () => {
    const secret = `key with spaces & symbols=+/? ${crypto.randomUUID()}`;
    issuer().state.introspect = () => jsonResponse(200, active());
    const before = introspections().length;
    expectReached(await suggest(secret));
    expect(introspections().slice(before)[0].form.get("token")).toBe(secret);
    expect(introspections().slice(before)[0].body).toBe(`token=${new URLSearchParams({ v: secret }).toString().slice(2)}`);
  });

  describe("the caller's address", () => {
    const passed: [string, Record<string, string>, string][] = [
      ["the connection's own, when no header names one", {}, "127.0.0.1"],
      ["an IPv4 address from X-Real-IP", { "X-Real-IP": "198.51.100.23" }, "198.51.100.23"],
      ["an IPv6 address", { "X-Real-IP": "2001:db8::17" }, "2001:db8::17"],
      ["an IPv6 address with a zone", { "X-Real-IP": "fe80::1%eth0" }, "fe80::1%eth0"],
      ["an IPv4-mapped IPv6 address", { "X-Real-IP": "::ffff:192.0.2.1" }, "::ffff:192.0.2.1"],
      ["the first X-Forwarded-For entry", { "X-Forwarded-For": "198.51.100.7, 10.0.0.1" }, "198.51.100.7"],
      ["X-Real-IP rather than X-Forwarded-For", { "X-Real-IP": "192.0.2.44", "X-Forwarded-For": "198.51.100.7" }, "192.0.2.44"],
    ];
    for (const [what, headers, expected] of passed) {
      test(`is passed on: ${what}`, async () => {
        issuer().state.introspect = () => jsonResponse(200, active());
        const before = introspections().length;
        expectReached(await suggest(providerKey(), { headers }));
        expect(introspections().slice(before)[0].headers["x-real-ip"]).toBe(expected);
      });
    }

    const withheld: [string, Record<string, string>][] = [
      ["a name", { "X-Real-IP": "gateway.internal" }],
      ["an address with a port", { "X-Real-IP": "198.51.100.23:4711" }],
      ["an address in brackets", { "X-Real-IP": "[2001:db8::17]" }],
      ["an address with a leading zero", { "X-Real-IP": "198.051.100.23" }],
      ["a zone with a character no zone has", { "X-Real-IP": "fe80::1%eth_0" }],
      ["two addresses", { "X-Real-IP": "198.51.100.23, 10.0.0.1" }],
      ["an empty first X-Forwarded-For entry", { "X-Forwarded-For": ", 198.51.100.7" }],
    ];
    for (const [what, headers] of withheld) {
      test(`is left out when it is not an address: ${what}`, async () => {
        issuer().state.introspect = () => jsonResponse(200, active());
        const before = introspections().length;
        expectReached(await suggest(providerKey(), { headers }));
        expect(introspections().slice(before)[0].headers["x-real-ip"]).toBeUndefined();
      });
    }
  });

  describe("is refused", () => {
    const answers: [string, () => Record<string, unknown>][] = [
      ["when it is not active", () => ({ active: false })],
      ["when the answer does not say it is active", () => ({ sub: holder.sub, username: "keyholder", role: "user", scope: SCOPE })],
      ['when "active" is text', () => active({ active: "true" })],
      ['when "active" is a number', () => active({ active: 1 })],
      ["when it lacks the route's scope", () => active({ scope: "transactions:read accounts:read" })],
      ["when it has no scope", () => active({ scope: undefined })],
      ["when its scope is empty", () => active({ scope: "" })],
      ["when its scope is a list rather than text", () => active({ scope: [SCOPE] })],
      ["when the route's scope is only part of one of its scopes", () => active({ scope: `${SCOPE}:all x${SCOPE}` })],
      ["when its scopes are separated by something other than a space", () => active({ scope: `other,${SCOPE}` })],
      ["when its owner is nobody here", () => active({ sub: "usr_never_signed_in" })],
      ["when its owner is named by username rather than subject", () => active({ sub: "keyholder" })],
    ];
    for (const [what, answer] of answers) {
      test(what, async () => {
        issuer().state.introspect = () => jsonResponse(200, answer());
        expectRefused(await suggest(providerKey()));
      });
    }

    test("when the provider is rate limiting, and is asked again the next time", async () => {
      const secret = providerKey();
      issuer().state.introspect = () => jsonResponse(429, { error: "slow_down" });
      const before = introspections().length;
      expectRefused(await suggest(secret));
      issuer().state.introspect = () => new Response("slow down", { status: 429 });
      expectRefused(await suggest(secret));
      expect(introspections()).toHaveLength(before + 2);
      issuer().state.introspect = () => jsonResponse(200, active());
      expectReached(await suggest(secret));
    });
  });

  test("is accepted with the scope anywhere among several", async () => {
    issuer().state.introspect = () => jsonResponse(200, active({ scope: `accounts:read  ${SCOPE} other` }));
    expectReached(await suggest(providerKey()));
  });

  test("needs no id, and its owner's role and username are not budget's concern", async () => {
    issuer().state.introspect = () => jsonResponse(200, active({ jti: undefined, role: "", username: "someone-else-entirely" }));
    expectReached(await suggest(providerKey()));
  });

  test("of a deleted local user is refused", async () => {
    const client = stack.anonymous();
    await ssoSignIn(stack, client, { claims: { sub: "usr_deleted_holder", username: "deleted-holder", sid: "ses_deleted_holder" } });
    const secret = providerKey();
    issuer().state.introspect = () => jsonResponse(200, active({ sub: "usr_deleted_holder" }));
    expectReached(await suggest(secret));
    await stack.db.query("UPDATE users SET is_deleted = TRUE WHERE auth_sub = $1", ["usr_deleted_holder"]);
    expectRefused(await suggest(secret));
  });
});

describe("when the provider cannot say", () => {
  const failures: [string, () => void][] = [
    ["it is failing on its side", () => (issuer().state.down = true)],
    ["it answers 500 to the question", () => (issuer().state.introspect = () => jsonResponse(500, { active: true }))],
    ["it cannot be reached", () => issuer().setUnreachable(true)],
    ["it answers with something that is not JSON", () => (issuer().state.introspect = () => new Response("<html></html>", { status: 200 }))],
    ["it answers with a JSON list", () => (issuer().state.introspect = () => jsonResponse(200, [active()]))],
    ["it refuses with something that is not JSON", () => (issuer().state.introspect = () => new Response("no", { status: 401 }))],
    ["an active answer names no owner", () => (issuer().state.introspect = () => jsonResponse(200, active({ sub: undefined })))],
    ["an active answer names no username", () => (issuer().state.introspect = () => jsonResponse(200, active({ username: undefined })))],
    ["an active answer names no role", () => (issuer().state.introspect = () => jsonResponse(200, active({ role: null })))],
    ["an active answer's owner is not text", () => (issuer().state.introspect = () => jsonResponse(200, active({ sub: 5 })))],
  ];
  for (const [what, breakIt] of failures) {
    test(`(${what}) the caller is told to try again, not that the key is bad`, async () => {
      breakIt();
      expectCannotCheck(await suggest(providerKey()));
    });
  }

  test("nothing is remembered of it: the next request asks again, and is answered", async () => {
    const secret = providerKey();
    const before = introspections().length;
    issuer().state.down = true;
    expectCannotCheck(await suggest(secret));
    expectCannotCheck(await suggest(secret));
    issuer().state.down = false;
    issuer().state.introspect = () => jsonResponse(200, active());
    expectReached(await suggest(secret));
    expect(introspections()).toHaveLength(before + 3);
  });

  test("a signed-in caller is not affected: the session is all that is looked at", async () => {
    issuer().state.down = true;
    const before = introspections().length;
    const result = await holder.client.post("/suggest-category", { suggestions: [] }, { headers: { Authorization: `Bearer ${providerKey()}` } });
    expect(result.status).toBe(200);
    expect(introspections()).toHaveLength(before);
  });

  test("a refusal of the question itself is a fault here, not an outage", async () => {
    const before = stack.upstream.discord.alarms().length;
    for (const answer of [() => jsonResponse(400, { error: "invalid_request" }), () => jsonResponse(401, { error: "invalid_client" }), () => jsonResponse(403, {})]) {
      issuer().state.introspect = answer;
      // The request fails outside any route, and each server words that failure its own way.
      const result = await suggest(providerKey(), { noCompare: true });
      expect(result.status).toBe(500);
    }
    await stack.waitForLog("introspection refused the request (invalid_request)");
    await stack.waitForLog("introspection refused the request (invalid_client)");
    await stack.waitForLog("introspection refused the request (403)");
    // No route ran, so no route error alarm either.
    expect(stack.upstream.discord.alarms()).toHaveLength(before);
  });
});

describe("what the provider said is remembered for a minute", () => {
  test("a second request with the same key does not ask again, whatever the provider would say now", async () => {
    const secret = providerKey();
    issuer().state.introspect = () => jsonResponse(200, active());
    const before = introspections().length;
    expectReached(await suggest(secret));
    issuer().state.introspect = () => jsonResponse(200, { active: false });
    expectReached(await suggest(secret));
    issuer().state.down = true;
    expectReached(await suggest(secret));
    issuer().setUnreachable(true);
    expectReached(await suggest(secret));
    expect(introspections()).toHaveLength(before + 1);
  });

  test("an active key without the scope, or with an owner unknown here, is remembered too", async () => {
    const [unscoped, unlinked] = [providerKey(), providerKey()];
    const before = introspections().length;
    issuer().state.introspect = (form) =>
      jsonResponse(200, form.get("token") === unscoped ? active({ scope: "other" }) : active({ sub: "usr_never_signed_in" }));
    expectRefused(await suggest(unscoped));
    expectRefused(await suggest(unlinked));
    issuer().state.introspect = () => jsonResponse(200, active());
    expectRefused(await suggest(unscoped));
    expectRefused(await suggest(unlinked));
    expect(introspections()).toHaveLength(before + 2);
  });

  test("an inactive key is not remembered: it is asked about every time", async () => {
    const secret = providerKey();
    const before = introspections().length;
    expectRefused(await suggest(secret));
    expectRefused(await suggest(secret));
    expect(introspections()).toHaveLength(before + 2);
    issuer().state.introspect = () => jsonResponse(200, active());
    expectReached(await suggest(secret));
  });

  test("each key is remembered by itself", async () => {
    const [first, second] = [providerKey(), providerKey()];
    issuer().state.introspect = () => jsonResponse(200, active());
    const before = introspections().length;
    expectReached(await suggest(first));
    expectReached(await suggest(second));
    expectReached(await suggest(first));
    expect(introspections().slice(before).map((request) => request.form.get("token"))).toEqual([first, second]);
  });

  test("the address of a later caller is not sent anywhere: nothing is", async () => {
    const secret = providerKey();
    issuer().state.introspect = () => jsonResponse(200, active());
    const before = introspections().length;
    expectReached(await suggest(secret, { headers: { "X-Real-IP": "203.0.113.1" } }));
    expectReached(await suggest(secret, { headers: { "X-Real-IP": "203.0.113.2" } }));
    expect(introspections().slice(before).map((request) => request.headers["x-real-ip"])).toEqual(["203.0.113.1"]);
  });

  test("until the provider says the credential was revoked", async () => {
    const [revoked, other] = [providerKey(), providerKey()];
    issuer().state.introspect = (form) => jsonResponse(200, active({ jti: form.get("token") === revoked ? "key_revoked" : "key_other" }));
    expectReached(await suggest(revoked));
    expectReached(await suggest(other));
    const before = introspections().length;

    expect((await sendEvent({ "credential.revoked": { sub: holder.sub, id: "key_revoked" } })).status).toBe(202);
    issuer().state.introspect = () => jsonResponse(200, { active: false });
    // Asked about again, and now refused; the other key's answer still stands.
    expectRefused(await suggest(revoked));
    expectReached(await suggest(other));
    expect(introspections().slice(before).map((request) => request.form.get("token"))).toEqual([revoked]);
  });

  const forgetting: [string, (sub: string) => object][] = [
    ["was disabled", (sub) => ({ "user.disabled": { sub } })],
    ["was deleted", (sub) => ({ "user.deleted": { sub } })],
    ["lost their access", (sub) => ({ "access.changed": { sub, role: null } })],
    ["changed role", (sub) => ({ "access.changed": { sub, role: "viewer" } })],
  ];
  for (const [what, eventOf] of forgetting) {
    test(`until the provider says its owner ${what}: every key of theirs is asked about again`, async () => {
      const slug = what.replace(/[^a-z]+/g, "_");
      const owner = { sub: `usr_owner_${slug}`, username: `owner-${slug}`, sid: `ses_owner_${slug}` };
      await ssoSignIn(stack, stack.anonymous(), { claims: owner });
      const [first, second, bystander] = [providerKey(), providerKey(), providerKey()];
      issuer().state.introspect = (form) => jsonResponse(200, active({ sub: form.get("token") === bystander ? holder.sub : owner.sub }));
      for (const secret of [first, second, bystander]) expectReached(await suggest(secret));
      const before = introspections().length;

      expect((await sendEvent(eventOf(owner.sub))).status).toBe(202);
      // The provider is the judge of the key: while it calls the key active, it authenticates.
      expectReached(await suggest(first));
      issuer().state.introspect = () => jsonResponse(200, { active: false });
      expectRefused(await suggest(second));
      expectReached(await suggest(bystander));
      expect(introspections().slice(before).map((request) => request.form.get("token"))).toEqual([first, second]);
    });
  }

  test("an event about someone or something else forgets nothing", async () => {
    const secret = providerKey();
    issuer().state.introspect = () => jsonResponse(200, active({ jti: "key_kept" }));
    expectReached(await suggest(secret));
    const before = introspections().length;
    for (const event of [
      { "credential.revoked": { sub: holder.sub, id: "key_another" } },
      { "user.disabled": { sub: "usr_never_signed_in" } },
      { "session.ended": { sid: "ses_keyholder_other" } },
      { "invite.accepted": { invite: "inv_1", sub: holder.sub } },
      { "something.new": { sub: holder.sub, id: "key_kept" } },
    ]) {
      expect((await sendEvent(event)).status).toBe(202);
    }
    issuer().state.down = true;
    expectReached(await suggest(secret));
    expect(introspections()).toHaveLength(before);
  });
});

describe("budget's own keys", () => {
  const issue = async (): Promise<{ key_id: string; plaintext: string }> => {
    const result = await holder.client.post<{ key_id: string; plaintext: string }>("/api-keys", { name: "own", scopes: [SCOPE] });
    expect(result.json.status).toBe("success");
    return result.body;
  };

  test("are checked here and never shown to the provider", async () => {
    const key = await issue();
    issuer().state.down = true;
    const before = introspections().length;
    expectReached(await suggest(key.plaintext));
    expectReached(await suggest(key.plaintext));
    expect(introspections()).toHaveLength(before);
  });

  test("that carry the wrong scope are refused here, without asking", async () => {
    const key = await issue();
    await stack.db.query("UPDATE api_keys SET scopes = $2 WHERE key_id = $1", [key.key_id, ["transactions:read"]]);
    issuer().state.introspect = () => jsonResponse(200, active());
    const before = introspections().length;
    expectRefused(await suggest(key.plaintext));
    expect(introspections()).toHaveLength(before);
  });

  test("once revoked or expired are unknown here, so the provider is asked, and says no", async () => {
    const revoked = await issue();
    const expired = await issue();
    await holder.client.delete("/api-keys", { query: { key_id: revoked.key_id } });
    await stack.db.query("UPDATE api_keys SET expires_at = $2 WHERE key_id = $1", [expired.key_id, new Date(Date.now() - 1000)]);
    const before = introspections().length;
    expectRefused(await suggest(revoked.plaintext));
    expectRefused(await suggest(expired.plaintext));
    expect(introspections().slice(before).map((request) => request.form.get("token"))).toEqual([revoked.plaintext, expired.plaintext]);
    // And with the provider out, such a key cannot be told from one of its own.
    issuer().state.down = true;
    expectCannotCheck(await suggest(revoked.plaintext));
  });

  test("a key that only looks like one of budget's is the provider's to judge", async () => {
    const lookalike = `bk_${"A".repeat(43)}`;
    const before = introspections().length;
    expectRefused(await suggest(lookalike));
    issuer().state.introspect = () => jsonResponse(200, active());
    expectReached(await suggest(lookalike));
    expect(introspections().slice(before).map((request) => request.form.get("token"))).toEqual([lookalike, lookalike]);
  });
});

describe("where no key is looked at", () => {
  test("a route that declares no scope, a header that is not a bearer token, an unknown path", async () => {
    issuer().state.introspect = () => jsonResponse(200, active());
    const before = introspections().length;
    const headers = { Authorization: `Bearer ${providerKey()}` };
    const anonymous = stack.anonymous();
    expectRefused(await anonymous.get("/api-keys", { headers }));
    expectRefused(await anonymous.get("/events", { headers }));
    expectRefused(await anonymous.get("/suggest-category", { headers }));
    expectRefused(await anonymous.post("/no-such-route", {}, { headers }));
    expectRefused(await anonymous.post("/suggest-category", { suggestions: [] }, { headers: { Authorization: "Basic abc" } }));
    expectRefused(await anonymous.post("/suggest-category", { suggestions: [] }, { headers: { Authorization: "Bearer " } }));
    const who = await anonymous.get("/login", { headers });
    expect(who.json.message).toBe("Not logged in.");
    expect(introspections()).toHaveLength(before);
  });
});
