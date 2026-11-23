/**
 * What the servers learn from the identity provider and keep: its discovery
 * document and its signing keys. Both are held for the life of the process,
 * so each case here starts from a server that has just been restarted.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  CLIENT_ID,
  ISSUER,
  ISSUER_HOST,
  REDIRECT_URI,
  jsonResponse,
  startStack,
  type ApiClient,
  type ApiResult,
  type Stack,
} from "../harness";
import { CLEAR_LOGIN_COOKIE, LOGIN_COOKIE_NAME, encodeLoginCookie, finishSsoLogin, ssoSignIn, startSsoLogin, tokenAnswer } from "../harness/sso";

// Tests here start, restart and wait on real server processes: give each the suite's 30 seconds
// rather than the runner's default of five.
setDefaultTimeout(30_000);

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({ sso: true });
});
afterAll(() => stack.stop());

const issuer = () => stack.upstream.issuer;
const DISCOVERY = "/.well-known/openid-configuration";
const JWKS = "/.well-known/jwks.json";
const SERVER_ERROR = { status: "error", message: "Internal server error" };
const nowS = () => Math.floor(Date.now() / 1000);
const formEncode = (text: string) => new URLSearchParams({ v: text }).toString().slice(2);

const overrides: (() => void)[] = [];
/** Answers `path` at the provider with `answer` until the next fresh server. */
const override = (path: string, answer: () => Response): void => {
  overrides.push(stack.upstream.hub.on(ISSUER_HOST, (request) => (request.path === path ? answer() : undefined)));
};

/** A server process that has never spoken to the provider, and a provider back to its defaults but for `prepare`. */
const freshServer = async (prepare: () => void = () => undefined): Promise<void> => {
  for (const remove of overrides.splice(0)) remove();
  issuer().reset();
  issuer().setUnreachable(false);
  prepare();
  await stack.restart();
};

const expectUnavailable = (result: ApiResult) => {
  expect(result.status).toBe(302);
  expect(result.headers.get("location")).toBe("/login?sso_error=unavailable");
  expect(result.setCookies).toEqual([CLEAR_LOGIN_COOKIE]);
};

const expectToProvider = (result: ApiResult) => {
  expect(result.status).toBe(302);
  expect(result.headers.get("location")).toStartWith(`${ISSUER}/oauth/authorize?`);
};

/** A callback for a sign-in whose cookie the test wrote itself, for when `/auth/login` cannot start one. */
const craftedCallback = (client: ApiClient = stack.anonymous()) => {
  const login = { state: "s".repeat(43), nonce: "n".repeat(43), verifier: "v".repeat(43), returnTo: "/", iat: nowS(), fresh: false };
  client.cookies.set(LOGIN_COOKIE_NAME, encodeLoginCookie(login));
  issuer().state.token = () => jsonResponse(200, tokenAnswer(stack, login));
  return client.get("/auth/callback", { query: { code: "the-code", state: login.state } });
};

let people = 0;
const newcomer = () => {
  const n = ++people;
  return { sub: `usr_provider_${n}`, username: `provider-${n}`, sid: `ses_provider_${n}` };
};

/** Waits for the alarm a failed `route` raised with `description`. */
const alarmFor = (description: string, route = "GET /auth/login") =>
  stack.waitFor(
    () =>
      stack.upstream.discord
        .alarms()
        .find((alarm) => alarm.description === description && alarm.title === `🚨 Budget Server Error: Route Error: ${route}`),
    { what: `the alarm "${description}" of ${route}` },
  );

describe("the discovery document", () => {
  test("is asked for again after each failure, and never again once it was read", async () => {
    await freshServer(() => issuer().setUnreachable(true));

    // Unreachable: nothing arrives at the provider at all.
    expectUnavailable(await stack.anonymous().get("/auth/login"));
    expectUnavailable(await craftedCallback());
    expect(issuer().seen(DISCOVERY)).toHaveLength(0);
    issuer().setUnreachable(false);

    // Answering, but not with a document.
    const before = issuer().seen(DISCOVERY).length;
    issuer().state.down = true;
    expectUnavailable(await stack.anonymous().get("/auth/login"));
    issuer().state.down = false;
    const failures: (() => Response)[] = [
      () => jsonResponse(404, { error: "not_found" }),
      () => jsonResponse(403, issuer().state.discovery),
      () => new Response("<html></html>", { status: 200 }),
      () => jsonResponse(200, [issuer().state.discovery]),
      () => jsonResponse(200, "discovery"),
      () => new Response(null, { status: 200 }),
      () => new Response(null, { status: 302, headers: { Location: `${issuer().backChannelUrl}/elsewhere` } }),
    ];
    for (const failure of failures) {
      override(DISCOVERY, failure);
      expectUnavailable(await stack.anonymous().get("/auth/login"));
    }
    expect(issuer().seen(DISCOVERY)).toHaveLength(before + 1 + failures.length);
    expect(issuer().seen("/elsewhere")).toEqual([]);
    for (const remove of overrides.splice(0)) remove();

    // Readable at last: read, and kept.
    expectToProvider(await stack.anonymous().get("/auth/login"));
    const read = issuer().seen(DISCOVERY).length;
    expect(read).toBe(before + failures.length + 2);
    issuer().state.down = true;
    override(DISCOVERY, () => jsonResponse(500, {}));
    expectToProvider(await stack.anonymous().get("/auth/login"));
    expectToProvider(await stack.anonymous().get("/auth/login"));
    expect(issuer().seen(DISCOVERY)).toHaveLength(read);
  });

  test("that names another issuer, or lacks an endpoint, is a fault here: nothing is redirected anywhere", async () => {
    await freshServer(() => {
      issuer().state.discovery.issuer = "https://other.example.test";
    });
    const result = await stack.anonymous().get("/auth/login");
    expect(result.status).toBe(500);
    expect(result.json).toEqual(SERVER_ERROR);
    expect(result.setCookies).toEqual([]);
    expect(result.headers.get("location")).toBeNull();
    await alarmFor("**Error:** the discovery document names a different issuer");
    // The callback fails the same way, as a fault and not as a refusal.
    const callback = await craftedCallback();
    expect(callback.status).toBe(500);
    expect(callback.json).toEqual(SERVER_ERROR);
    await alarmFor("**Error:** the discovery document names a different issuer", "GET /auth/callback");

    const wrong: [Record<string, unknown>, string][] = [
      [{ issuer: `${ISSUER}/` }, "the discovery document names a different issuer"],
      [{ issuer: undefined }, "the discovery document names a different issuer"],
      [{ issuer: [ISSUER] }, "the discovery document names a different issuer"],
      [{ authorization_endpoint: undefined }, "the discovery document has no authorization_endpoint"],
      [{ token_endpoint: 5 }, "the discovery document has no token_endpoint"],
      [{ jwks_uri: null }, "the discovery document has no jwks_uri"],
      // The first missing one is named.
      [{ token_endpoint: undefined, jwks_uri: undefined }, "the discovery document has no token_endpoint"],
    ];
    for (const [change, message] of wrong) {
      issuer().reset();
      Object.assign(issuer().state.discovery, change);
      const count = stack.logCount(message);
      expect((await stack.anonymous().get("/auth/login")).status).toBe(500);
      await stack.waitForLog(message, { count: count + 1 });
    }

    // Put right, the next attempt reads it: a refused document is not kept.
    issuer().reset();
    expectToProvider(await stack.anonymous().get("/auth/login"));
  });

  test("may leave out the endpoints signing in does not need", async () => {
    await freshServer(() => {
      const { discovery } = issuer().state;
      delete discovery.revocation_endpoint;
      delete discovery.introspection_endpoint;
      delete discovery.end_session_endpoint;
    });
    const client = stack.anonymous();
    await ssoSignIn(stack, client, { claims: newcomer() });
    expect((await client.get("/login")).json.status).toBe("success");
  });

  test("an authorization endpoint with a query of its own keeps it, with this sign-in's parameters set over it", async () => {
    await freshServer(() => {
      issuer().state.discovery.authorization_endpoint = `${ISSUER}/oauth/authorize?tenant=a%20b&client_id=old&scope=x&flag&scope=y#section`;
    });
    const started = await startSsoLogin(stack.anonymous());
    const params = started.location.searchParams;
    expect(started.location.hash).toBe("#section");
    // Parameters already there keep their place and take the new value; a repeated one is left once.
    expect(started.location.search).toBe(
      `?tenant=a+b&client_id=${CLIENT_ID}&scope=openid+profile+email&flag=&response_type=code&redirect_uri=${formEncode(REDIRECT_URI)}` +
        `&state=${params.get("state")}&nonce=${params.get("nonce")}&code_challenge=${params.get("code_challenge")}&code_challenge_method=S256`,
    );
  });

  test("an authorization endpoint that is not a URL is a fault here", async () => {
    await freshServer(() => {
      issuer().state.discovery.authorization_endpoint = "not a url";
    });
    const result = await stack.anonymous().get("/auth/login");
    expect(result.status).toBe(500);
    expect(result.json).toEqual(SERVER_ERROR);
    await alarmFor("**Error:** Invalid URL");
  });

  test("an endpoint that is not the issuer's own is called where it is, not over the back channel", async () => {
    // A host the upstream proxy's certificate covers, standing in for a provider that keeps its token endpoint elsewhere.
    const elsewhere = "other.simplefin.test";
    await freshServer(() => {
      issuer().state.discovery.token_endpoint = `https://${elsewhere}/oauth/token`;
    });
    const client = stack.anonymous();
    const started = await startSsoLogin(client);
    const who = newcomer();
    const remove = stack.upstream.hub.on(elsewhere, (request) =>
      request.path === "/oauth/token" ? jsonResponse(200, tokenAnswer(stack, started, { claims: who })) : undefined,
    );
    try {
      const seenBefore = issuer().seen("/oauth/token").length;
      const result = await client.get("/auth/callback", { query: { code: "the-code", state: started.state } });
      expect(result.status).toBe(302);
      expect(result.headers.get("location")).toBe("/");
      const calls = stack.upstream.hub.seen(elsewhere, "/oauth/token");
      expect(calls).toHaveLength(1);
      expect(calls[0].form.get("grant_type")).toBe("authorization_code");
      expect(calls[0].headers.authorization).toStartWith("Basic ");
      expect(issuer().seen("/oauth/token")).toHaveLength(seenBefore);
    } finally {
      remove();
    }
  });
});

describe("the provider's signing keys", () => {
  const signIn = async (): Promise<ApiResult> => {
    const client = stack.anonymous();
    const started = await startSsoLogin(client);
    return finishSsoLogin(stack, client, started, { claims: newcomer() });
  };
  const expectFailed = (result: ApiResult, error: string) => {
    expect(result.status).toBe(302);
    expect(result.headers.get("location")).toBe(`/login?sso_error=${error}`);
  };
  const event = () =>
    stack.anonymous().request("POST", "/auth/events", {
      rawBody: issuer().eventToken({ "invite.accepted": { invite: "inv_1", sub: "usr_nobody" } }, { jti: "evt_keys" }),
      headers: { "Content-Type": "application/secevent+jwt" },
    });

  test("are fetched once, when the first token needs them, and not for a key id they do not hold", async () => {
    await freshServer();
    const before = issuer().seen(JWKS).length;
    await startSsoLogin(stack.anonymous());
    // Starting a sign-in verifies nothing.
    expect(issuer().seen(JWKS)).toHaveLength(before);
    expect((await signIn()).headers.get("location")).toBe("/");
    expect((await event()).status).toBe(202);
    expect(issuer().seen(JWKS)).toHaveLength(before + 1);

    // A key id nobody published: refused, and no second fetch so soon after the first.
    const client = stack.anonymous();
    const started = await startSsoLogin(client);
    issuer().state.token = () =>
      jsonResponse(200, { ...tokenAnswer(stack, started), access_token: issuer().accessToken({}, { kid: "k-unpublished" }) });
    expectFailed(await client.get("/auth/callback", { query: { code: "the-code", state: started.state } }), "failed");
    const unknown = await stack.anonymous().request("POST", "/auth/events", {
      rawBody: issuer().eventToken({ "invite.accepted": { invite: "inv_1", sub: "usr_nobody" } }, {}, { kid: "" }),
    });
    expect(unknown.status).toBe(400);
    expect(issuer().seen(JWKS)).toHaveLength(before + 1);
  });

  test("that cannot be fetched leave tokens unverifiable, and are not asked for again right away", async () => {
    await freshServer(() => override(JWKS, () => jsonResponse(404, { error: "not_found" })));
    const before = issuer().seen(JWKS).length;
    expectFailed(await signIn(), "unavailable");
    expect(issuer().seen(JWKS)).toHaveLength(before + 1);
    const refused = await event();
    expect(refused.status).toBe(503);
    expect(refused.json).toEqual({ status: "failed", message: "Cannot verify the security event token yet." });

    // The key set is back, but it was asked for a moment ago: the answer stays "not yet".
    for (const remove of overrides.splice(0)) remove();
    expectFailed(await signIn(), "unavailable");
    expect((await event()).status).toBe(503);
    expect(issuer().seen(JWKS)).toHaveLength(before + 1);
  });

  const unreadable: [string, () => Response][] = [
    ["a server error", () => jsonResponse(500, { keys: [] })],
    ["something that is not JSON", () => new Response("keys", { status: 200 })],
    ["a JSON array", () => jsonResponse(200, [])],
    ["a redirect", () => new Response(null, { status: 301, headers: { Location: "/keys" } })],
  ];
  for (const [what, answer] of unreadable) {
    test(`answered with ${what} are unavailable`, async () => {
      await freshServer(() => override(JWKS, answer));
      expectFailed(await signIn(), "unavailable");
      expect((await event()).status).toBe(503);
    });
  }

  test("that hold nothing usable verify nothing", async () => {
    let published: unknown = { keys: [] };
    await freshServer(() => override(JWKS, () => jsonResponse(200, published)));
    // The real key is fetched by the harness the same way the servers would, to be published in altered forms.
    const real = await (async () => {
      for (const remove of overrides.splice(0)) remove();
      const jwks = (await (await fetch(`${issuer().backChannelUrl}${JWKS}`)).json()) as { keys: Record<string, unknown>[] };
      override(JWKS, () => jsonResponse(200, published));
      return jwks.keys[0];
    })();
    const { x, kid } = real as { x: string; kid: string };
    published = {
      keys: [
        "not a key",
        null,
        5,
        { ...real, kty: "RSA" },
        { ...real, crv: "X25519" },
        { ...real, crv: "ed25519" },
        { ...real, use: "enc" },
        { ...real, use: null },
        { ...real, alg: "ES256" },
        { ...real, alg: null },
        { ...real, kid: undefined },
        { ...real, kid: 1 },
        { ...real, x: undefined },
        { ...real, x: x.slice(0, -2) },
        { ...real, x: `${x}AA` },
        { ...real, x: [x] },
        { kty: "OKP", crv: "Ed25519", x, kid: "another-id" },
      ],
    };
    expect(kid).toBe("k1");
    const fetched = issuer().seen(JWKS).length;
    expectFailed(await signIn(), "failed");
    expect((await event()).status).toBe(400);
    // Fetched once (the harness's own read aside), and found wanting: no second fetch so soon.
    expect(issuer().seen(JWKS)).toHaveLength(fetched + 1);
  });

  test("need only say what they are: the type, the curve, the key and its id", async () => {
    let published: unknown = { keys: [] };
    await freshServer(() => override(JWKS, () => jsonResponse(200, published)));
    for (const remove of overrides.splice(0)) remove();
    const jwks = (await (await fetch(`${issuer().backChannelUrl}${JWKS}`)).json()) as { keys: Record<string, unknown>[] };
    const { x, kid } = jwks.keys[0] as { x: string; kid: string };
    published = {
      keys: [{ kty: "RSA", kid: "an-rsa-key", n: "AQAB", e: "AQAB" }, { kty: "OKP", crv: "Ed25519", x, kid, extra: true }],
      extra: "ignored",
    };
    override(JWKS, () => jsonResponse(200, published));
    expect((await signIn()).headers.get("location")).toBe("/");
    expect((await event()).status).toBe(202);
  });

  test("published twice under one id: the later entry is the key", async () => {
    let published: unknown = { keys: [] };
    await freshServer(() => override(JWKS, () => jsonResponse(200, published)));
    for (const remove of overrides.splice(0)) remove();
    const jwks = (await (await fetch(`${issuer().backChannelUrl}${JWKS}`)).json()) as { keys: Record<string, unknown>[] };
    const real = jwks.keys[0] as { x: string; kid: string };
    const other = { ...real, x: Buffer.alloc(32, 7).toString("base64url") };
    published = { keys: [other, real] };
    override(JWKS, () => jsonResponse(200, published));
    expect((await signIn()).headers.get("location")).toBe("/");

    published = { keys: [real, other] };
    await stack.restart();
    expectFailed(await signIn(), "failed");
  });
});
