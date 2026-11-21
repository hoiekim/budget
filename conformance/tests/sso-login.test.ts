/**
 * Signing in through the identity provider: `GET /auth/login` sends the
 * browser there, `GET /auth/callback` brings it back, checks everything the
 * provider said, finds or creates the user and starts the session.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  ISSUER,
  ISSUER_HOST,
  REDIRECT_URI,
  createUser,
  jsonResponse,
  startStack,
  type ApiClient,
  type ApiResult,
  type Stack,
} from "../harness";
import {
  CLEAR_LOGIN_COOKIE,
  LOGIN_COOKIE_NAME,
  decodeLoginCookie,
  encodeLoginCookie,
  finishSsoLogin,
  sessionRow,
  ssoSignIn,
  startSsoLogin,
  tokenAnswer,
  type StartedSsoLogin,
} from "../harness/sso";

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({
    sso: { AUTH_LINK_USERS: "local-carol=carol, local-dave = dave ,ghost-account=erin,linked-account=frank" },
  });
});
afterAll(() => stack.stop());
afterEach(() => stack.upstream.issuer.reset());

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_COOKIE = /^session_id=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}; Max-Age=604800; Path=\/; HttpOnly; SameSite=Strict$/;
const SERVER_ERROR = { status: "error", message: "Internal server error" };
const nowS = () => Math.floor(Date.now() / 1000);
const formEncode = (text: string) => new URLSearchParams({ v: text }).toString().slice(2);

/** A sign-in started by a browser of its own. */
const begin = async (query?: Record<string, string | string[]>): Promise<{ client: ApiClient; started: StartedSsoLogin }> => {
  const client = stack.anonymous();
  return { client, started: await startSsoLogin(client, query ? { query } : {}) };
};

/** The provider's redirect back, as the browser follows it. */
const callback = (client: ApiClient, started: { state: string }, query: Record<string, string | string[]> = {}): Promise<ApiResult> =>
  client.get("/auth/callback", { query: { code: "the-code", state: started.state, ...query } });

/** Sent back to the sign-in page with the reason, the login cookie deleted, and no session. */
const expectBackToSignIn = (result: ApiResult, error: string) => {
  expect(result.status).toBe(302);
  expect(result.headers.get("location")).toBe(`/login?sso_error=${error}`);
  expect(result.setCookies).toEqual([CLEAR_LOGIN_COOKIE]);
  expect(result.text).toBe("");
};

const expectSignedIn = (result: ApiResult, location = "/") => {
  expect(result.status).toBe(302);
  expect(result.headers.get("location")).toBe(location);
  expect(result.setCookies).toEqual([CLEAR_LOGIN_COOKIE, expect.stringMatching(SESSION_COOKIE)]);
  expect(result.text).toBe("");
};

const tokenRequests = () => stack.upstream.issuer.seen("/oauth/token");
const userByName = (username: string) => stack.db.one("SELECT * FROM users WHERE username = $1", [username]);
const userBySub = (sub: string) => stack.db.one("SELECT * FROM users WHERE auth_sub = $1", [sub]);
const whoAmI = async (client: ApiClient) =>
  (await client.get<{ user?: { user_id: string; username: string } }>("/login")).body.user;

let subjects = 0;
/** Claims of a person nobody has seen before. */
const newcomer = (name = "newcomer") => {
  const n = ++subjects;
  return { sub: `usr_${name}_${n}`, username: `${name}-${n}`, sid: `ses_${name}_${n}` };
};

describe("GET /auth/login", () => {
  test("sends the browser to the provider with a fresh state, nonce and PKCE challenge, carried over in a cookie", async () => {
    const client = stack.anonymous();
    const before = nowS();
    const result = await client.get("/auth/login");
    expect(result.status).toBe(302);
    expect(result.text).toBe("");
    expect(result.headers.get("content-type")).toBeNull();
    expect(result.headers.get("x-content-type-options")).toBe("nosniff");
    expect(result.headers.get("x-frame-options")).toBe("DENY");
    expect(result.headers.get("strict-transport-security")).toBeNull();

    const location = new URL(result.headers.get("location") as string);
    expect(`${location.origin}${location.pathname}`).toBe(`${ISSUER}/oauth/authorize`);
    expect(location.hash).toBe("");
    const params = Object.fromEntries(location.searchParams);
    expect(params).toEqual({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: "openid profile email",
      state: expect.stringMatching(TOKEN),
      nonce: expect.stringMatching(TOKEN),
      code_challenge: expect.stringMatching(TOKEN),
      code_challenge_method: "S256",
    });
    // Written the way a form is: in this order, a space as a plus.
    expect(location.search).toBe(
      `?response_type=code&client_id=budget&redirect_uri=${formEncode(REDIRECT_URI)}&scope=openid+profile+email` +
        `&state=${params.state}&nonce=${params.nonce}&code_challenge=${params.code_challenge}&code_challenge_method=S256`,
    );

    expect(result.setCookies).toHaveLength(1);
    const match = /^__Host-login=([A-Za-z0-9_-]+); Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=300$/.exec(result.setCookies[0]);
    expect(match).not.toBeNull();
    const cookie = decodeLoginCookie((match as RegExpExecArray)[1]);
    expect(cookie).toEqual({
      state: params.state,
      nonce: params.nonce,
      verifier: expect.stringMatching(TOKEN),
      returnTo: "/",
      iat: expect.any(Number),
      fresh: false,
    });
    expect(Object.keys(cookie)).toEqual(["state", "nonce", "verifier", "returnTo", "iat", "fresh"]);
    expect(cookie.iat).toBeGreaterThanOrEqual(before);
    expect(cookie.iat).toBeLessThanOrEqual(nowS());
    expect(Number.isInteger(cookie.iat)).toBe(true);
    expect(params.code_challenge).toBe(createHash("sha256").update(cookie.verifier).digest("base64url"));
    expect(new Set([params.state, params.nonce, cookie.verifier]).size).toBe(3);
    // No session comes of it.
    expect(client.cookies.has("session_id")).toBe(false);
  });

  test("gives every sign-in its own state, nonce and verifier", async () => {
    const first = (await begin()).started;
    const second = (await begin()).started;
    expect(second.state).not.toBe(first.state);
    expect(second.nonce).not.toBe(first.nonce);
    expect(second.cookie.verifier).not.toBe(first.cookie.verifier);
    expect(second.location.searchParams.get("code_challenge")).not.toBe(first.location.searchParams.get("code_challenge"));
  });

  test("reads the provider's discovery document once, over the back channel, however many sign-ins start", async () => {
    await begin();
    await begin();
    const requests = stack.upstream.issuer.seen("/.well-known/openid-configuration");
    expect(requests).toHaveLength(1);
    expect(requests[0].host).toBe(ISSUER_HOST);
    expect(requests[0].method).toBe("GET");
    expect(requests[0].headers.accept).toBe("application/json");
    expect(requests[0].headers.authorization).toBeUndefined();
  });

  describe("returnTo", () => {
    const kept: [string, string][] = [
      ["a path", "/budgets"],
      ["the root", "/"],
      ["a path with a query and a fragment", "/accounts/5?tab=history&x=1#latest"],
      ["a path with a URL inside its query", "/a?next=https://evil.example/"],
      ["percent-encoded slashes, which stay encoded", "/%2F%2Fevil.example"],
      ["letters outside ASCII", "/é?x=ü"],
      ["letters outside Latin-1", "/日本/予算"],
      ["quotes", `/a"b'c`],
      ["2048 characters", `/${"a".repeat(2047)}`],
      ["2048 UTF-16 units of characters outside the basic plane", `/${"🔑".repeat(1023)}a`],
    ];
    for (const [what, returnTo] of kept) {
      test(`keeps ${what}`, async () => {
        const { started } = await begin({ returnTo });
        expect(started.cookie.returnTo).toBe(returnTo);
        // It travels in the cookie only, never to the provider.
        expect(started.location.searchParams.has("returnTo")).toBe(false);
        expect([...started.location.searchParams.keys()]).toHaveLength(8);
      });
    }

    const replaced: [string, string | string[]][] = [
      ["another site", "https://evil.example/"],
      ["a scheme-relative URL", "//evil.example/"],
      ["three slashes", "///evil.example"],
      ["a backslash after the slash", "/\\evil.example"],
      ["a backslash anywhere", "/a\\b"],
      ["a relative path", "budgets"],
      ["a dot path", "./budgets"],
      ["a space", "/a b"],
      ["a tab", "/a\tb"],
      ["a line feed", "/a\nb"],
      ["a carriage return", "/a\rb"],
      ["a NUL", "/a\u0000b"],
      ["a DEL", "/a\u007fb"],
      ["a leading space", " /budgets"],
      ["2049 characters", `/${"a".repeat(2048)}`],
      ["2049 UTF-16 units", `/${"🔑".repeat(1024)}`],
      ["an empty value", ""],
      ["a value given twice", ["/first", "/second"]],
    ];
    for (const [what, returnTo] of replaced) {
      test(`replaces ${what} with the root`, async () => {
        const { started } = await begin({ returnTo });
        expect(started.cookie.returnTo).toBe("/");
      });
    }

    test("is a case-sensitive parameter name", async () => {
      const { started } = await begin({ returnto: "/budgets", RETURNTO: "/budgets", return_to: "/budgets" });
      expect(started.cookie.returnTo).toBe("/");
    });
  });

  test("starts a sign-in for someone already signed in, and leaves their session alone", async () => {
    const client = stack.anonymous();
    await ssoSignIn(stack, client, { claims: newcomer("returning") });
    const sid = client.cookies.get("session_id");
    const result = await client.get("/auth/login");
    expect(result.status).toBe(302);
    expect(result.headers.get("location")).toStartWith(`${ISSUER}/oauth/authorize?`);
    // Only the login cookie: the route answers for itself, so the session cookie is not refreshed.
    expect(result.setCookies).toHaveLength(1);
    expect(result.setCookies[0]).toStartWith(`${LOGIN_COOKIE_NAME}=`);
    expect(client.cookies.get("session_id")).toBe(sid);
    expect((await whoAmI(client))?.username).toStartWith("returning-");
  });

  test("is a GET only: other verbs are not public, and are no route", async () => {
    for (const method of ["POST", "DELETE", "PUT", "PATCH"]) {
      const result = await stack.anonymous().request(method, "/auth/login");
      expect(result.status).toBe(401);
      expect(result.json).toEqual({ status: "failed", message: "Not authenticated." });
    }
    const client = stack.anonymous();
    await ssoSignIn(stack, client, { claims: newcomer("verbs") });
    const result = await client.post("/auth/login", {});
    expect(result.status).toBe(404);
    expect(result.json).toEqual({ status: "error", message: "Not Found" });
  });
});

describe("GET /auth/callback", () => {
  test("exchanges the code, creates the user, starts the session and sends the browser on", async () => {
    const { client, started } = await begin();
    const seen = tokenRequests().length;
    const before = Date.now();
    const who = { sub: "usr_first_time", username: "first-timer", sid: "ses_first_time" };
    const result = await finishSsoLogin(stack, client, started, {
      claims: who,
      idClaims: { email: "First.Timer@Example.com" },
      refreshToken: "rt-first-time",
    });
    expectSignedIn(result);
    expect(result.headers.get("x-content-type-options")).toBe("nosniff");
    expect(result.headers.get("content-type")).toBeNull();
    // The login cookie is spent.
    expect(client.cookies.has(LOGIN_COOKIE_NAME)).toBe(false);

    // The one call to the provider: the code, with the verifier the challenge was made from.
    const requests = tokenRequests().slice(seen);
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].host).toBe(ISSUER_HOST);
    expect(requests[0].body).toBe(
      `grant_type=authorization_code&code=the-code&redirect_uri=${formEncode(REDIRECT_URI)}&code_verifier=${started.cookie.verifier}`,
    );
    expect(requests[0].headers.authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`);
    expect(requests[0].headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(requests[0].headers.accept).toBe("application/json");

    // A user with no password, named by the token, with the ID token's email.
    const user = await userBySub(who.sub);
    expect(user).toMatchObject({ username: "first-timer", password: null, email: "First.Timer@Example.com", is_deleted: false });

    // A session that remembers the provider's session and when to ask it again.
    const session = await sessionRow(stack, client);
    expect(session).toMatchObject({
      user_user_id: user?.user_id,
      user_username: "first-timer",
      auth_sid: "ses_first_time",
      auth_refresh_token: "rt-first-time",
      cookie_signed: null,
      cookie_http_only: true,
      cookie_path: "/",
      cookie_domain: null,
      cookie_secure: false,
      cookie_same_site: "strict",
    });
    expect(Number(session?.cookie_original_max_age)).toBe(604_800_000);
    expect(Number(session?.cookie_max_age)).toBe(604_800_000);
    const recheckAt = (session?.auth_recheck_at as Date).getTime();
    expect(recheckAt).toBeGreaterThanOrEqual(before + 600_000 - 1000);
    expect(recheckAt).toBeLessThanOrEqual(Date.now() + 600_000 + 1000);
    const expires = (session?.cookie_expires as Date).getTime();
    expect(Math.abs(expires - (Date.now() + 604_800_000))).toBeLessThan(60_000);

    const login = await client.get("/login");
    expect(login.json).toEqual({
      status: "success",
      body: {
        user: { user_id: user?.user_id, username: "first-timer" },
        app: { version: expect.any(String) },
        sso: { enabled: true, localLogin: false },
      },
    });
  });

  test("sends the browser to where the sign-in was started for", async () => {
    for (const returnTo of ["/accounts/5?tab=history&x=1#latest", "/é?x=ü"]) {
      const { client, started } = await begin({ returnTo });
      expectSignedIn(await finishSsoLogin(stack, client, started, { claims: newcomer("return") }), returnTo);
    }
  });

  test("passes the code on as given, form-encoded", async () => {
    const { client, started } = await begin();
    const seen = tokenRequests().length;
    const code = "a b&c=d/é+%41?";
    expectSignedIn(await finishSsoLogin(stack, client, started, { claims: newcomer("code") }, { code }));
    expect(tokenRequests().slice(seen)[0].form.get("code")).toBe(code);
    expect(tokenRequests().slice(seen)[0].body).toContain(`&code=${formEncode(code)}&`);
  });

  test("keeps no refresh token when the provider gives none", async () => {
    const { client, started } = await begin();
    expectSignedIn(await finishSsoLogin(stack, client, started, { claims: newcomer("no-refresh"), refreshToken: null }));
    expect((await sessionRow(stack, client))?.auth_refresh_token).toBeNull();
  });

  test("replaces the session the browser had", async () => {
    const client = stack.anonymous();
    const who = newcomer("twice");
    await ssoSignIn(stack, client, { claims: who });
    const first = client.cookies.get("session_id") as string;
    await ssoSignIn(stack, client, { claims: { ...who, sid: "ses_twice_again" } });
    const second = client.cookies.get("session_id") as string;
    expect(second).not.toBe(first);
    await stack.waitFor(async () => (await stack.db.rows("sessions", { session_id: first })).length === 0, {
      what: "the old session to be deleted",
    });
    expect((await sessionRow(stack, client))?.auth_sid).toBe("ses_twice_again");
    // One person, one user.
    expect(await stack.db.rows("users", { auth_sub: who.sub })).toHaveLength(1);
  });

  test("never adopts a session id the browser made up", async () => {
    const { client, started } = await begin();
    client.cookies.set("session_id", "attacker-chosen");
    expectSignedIn(await finishSsoLogin(stack, client, started, { claims: newcomer("fixation") }));
    expect(client.cookies.get("session_id")).not.toBe("attacker-chosen");
    expect(await stack.db.rows("sessions", { session_id: "attacker-chosen" })).toEqual([]);
  });

  describe("a sign-in it cannot complete", () => {
    /** Refused before the provider is asked anything, with nothing stored. */
    const expectRefusedEarly = async (act: () => Promise<ApiResult>, error: string) => {
      const [requests, sessions, users] = [tokenRequests().length, await stack.db.rows("sessions"), await stack.db.rows("users")];
      expectBackToSignIn(await act(), error);
      expect(tokenRequests()).toHaveLength(requests);
      expect(await stack.db.rows("sessions")).toHaveLength(sessions.length);
      expect(await stack.db.rows("users")).toHaveLength(users.length);
    };

    test("no login cookie: the sign-in started in another browser, or long ago", async () => {
      const { started } = await begin();
      await expectRefusedEarly(() => callback(stack.anonymous(), started), "expired");
    });

    const unreadable: [string, string][] = [
      ["a cookie that is not base64url", "not.base64url"],
      ["a padded cookie", `${encodeLoginCookie({ state: "s" })}=`],
      ["an empty JSON object", encodeLoginCookie({})],
    ];
    for (const [what, value] of unreadable) {
      test(`${what} counts as no login cookie`, async () => {
        const { client, started } = await begin();
        client.cookies.set(LOGIN_COOKIE_NAME, value);
        await expectRefusedEarly(() => callback(client, started), "expired");
      });
    }

    test("a cookie missing any of what the sign-in needs counts as no login cookie", async () => {
      const { client, started } = await begin();
      const { state, nonce, verifier, iat } = started.cookie;
      const incomplete: Record<string, unknown>[] = [
        { nonce, verifier, iat },
        { state, verifier, iat },
        { state, nonce, iat },
        { state, nonce, verifier },
        { state, nonce, verifier, iat: String(iat) },
        { state, nonce, verifier, iat: null },
        { state: 5, nonce, verifier, iat },
        { state, nonce: null, verifier, iat },
        { state, nonce, verifier: ["v"], iat },
      ];
      for (const cookie of incomplete) {
        client.cookies.set(LOGIN_COOKIE_NAME, encodeLoginCookie(cookie));
        await expectRefusedEarly(() => callback(client, started), "expired");
      }
    });

    test("a base64url cookie that is not a JSON object is a failed sign-in, not an expired one", async () => {
      const { client, started } = await begin();
      for (const value of [
        Buffer.from("hello").toString("base64url"),
        Buffer.from('["state"]').toString("base64url"),
        Buffer.from('"state"').toString("base64url"),
        Buffer.from("5").toString("base64url"),
        Buffer.from("null").toString("base64url"),
        "A",
      ]) {
        client.cookies.set(LOGIN_COOKIE_NAME, value);
        await expectRefusedEarly(() => callback(client, started), "failed");
      }
    });

    test("a sign-in older than five minutes, or from the future, has expired", async () => {
      const { client, started } = await begin();
      for (const iat of [nowS() - 302, nowS() - 86_400, 0, nowS() + 32, nowS() + 86_400]) {
        client.cookies.set(LOGIN_COOKIE_NAME, encodeLoginCookie({ ...started.cookie, iat }));
        await expectRefusedEarly(() => callback(client, started), "expired");
      }
    });

    test("a sign-in just inside five minutes, or a moment ahead of the clock, still completes", async () => {
      for (const offset of [-295, 25]) {
        const { client, started } = await begin();
        client.cookies.set(LOGIN_COOKIE_NAME, encodeLoginCookie({ ...started.cookie, iat: nowS() + offset }));
        expectSignedIn(await finishSsoLogin(stack, client, started, { claims: newcomer("in-time") }));
      }
    });

    /** A refusal deletes the login cookie; this is the browser that still has it, for the next attempt. */
    const withCookie = (client: ApiClient, started: StartedSsoLogin): ApiClient => {
      client.cookies.set(LOGIN_COOKIE_NAME, encodeLoginCookie({ ...started.cookie }));
      return client;
    };

    test("the provider reporting that access was denied", async () => {
      const { client, started } = await begin();
      await expectRefusedEarly(() => callback(client, started, { error: "access_denied" }), "no_access");
      // The error decides, whatever else the redirect carries.
      await expectRefusedEarly(() => withCookie(client, started).get("/auth/callback", { query: { error: "access_denied" } }), "no_access");
      await expectRefusedEarly(
        () => callback(withCookie(client, started), started, { error: ["access_denied", "server_error"] }),
        "no_access",
      );
      await expectRefusedEarly(() => callback(withCookie(client, started), { state: "wrong" }, { error: "access_denied" }), "no_access");
    });

    test("the provider reporting any other error", async () => {
      const { client, started } = await begin();
      for (const error of ["server_error", "login_required", "", "ACCESS_DENIED", "access_denied ", "x".repeat(200)]) {
        await expectRefusedEarly(() => callback(withCookie(client, started), started, { error }), "failed");
      }
      await expectRefusedEarly(
        () => callback(withCookie(client, started), started, { error: ["server_error", "access_denied"] }),
        "failed",
      );
    });

    test("an error with no login cookie is still an expired sign-in", async () => {
      await expectRefusedEarly(() => stack.anonymous().get("/auth/callback", { query: { error: "access_denied" } }), "expired");
    });

    test("a state that is not the sign-in's", async () => {
      const { client, started } = await begin();
      const other = (await begin()).started;
      const browser = () => withCookie(client, started);
      await expectRefusedEarly(() => callback(browser(), { state: "wrong" }), "expired");
      await expectRefusedEarly(() => callback(browser(), { state: "" }), "expired");
      await expectRefusedEarly(() => callback(browser(), { state: other.state }), "expired");
      await expectRefusedEarly(() => callback(browser(), { state: `${started.state}x` }), "expired");
      await expectRefusedEarly(() => callback(browser(), { state: started.state.slice(0, -1) }), "expired");
      await expectRefusedEarly(() => callback(browser(), { state: `${started.state} ` }), "expired");
      await expectRefusedEarly(() => browser().get("/auth/callback", { query: { code: "the-code" } }), "expired");
      await expectRefusedEarly(() => browser().get("/auth/callback"), "expired");
      // Given twice, the first one counts.
      await expectRefusedEarly(
        () => browser().get("/auth/callback", { query: { code: "the-code", state: ["wrong", started.state] } }),
        "expired",
      );
    });

    test("no code", async () => {
      const { client, started } = await begin();
      const browser = () => withCookie(client, started);
      await expectRefusedEarly(() => browser().get("/auth/callback", { query: { state: started.state } }), "failed");
      await expectRefusedEarly(() => callback(browser(), started, { code: "" }), "failed");
      await expectRefusedEarly(() => callback(browser(), started, { code: ["", "the-code"] }), "failed");
    });

    test("a state and a code given twice: the first of each counts", async () => {
      const { client, started } = await begin();
      const seen = tokenRequests().length;
      expectSignedIn(
        await finishSsoLogin(stack, client, started, { claims: newcomer("twice-given") }, {
          code: ["first-code", "second-code"] as unknown as string,
          state: [started.state, "wrong"] as unknown as string,
        }),
      );
      expect(tokenRequests().slice(seen)[0].form.get("code")).toBe("first-code");
    });

    test("a refused sign-in can be started over, and then completes", async () => {
      const { client, started } = await begin();
      expectBackToSignIn(await callback(client, { state: "wrong" }), "expired");
      expect(client.cookies.has(LOGIN_COOKIE_NAME)).toBe(false);
      // The old redirect is no use any more: its cookie is gone.
      expectBackToSignIn(await callback(client, started), "expired");
      await ssoSignIn(stack, client, { claims: newcomer("retry") });
      expect((await whoAmI(client))?.username).toStartWith("retry-");
    });
  });

  describe("the token endpoint", () => {
    const issuer = () => stack.upstream.issuer;
    const answers: [string, () => Response, "failed" | "unavailable"][] = [
      ["refuses the code", () => jsonResponse(400, { error: "invalid_grant" }), "failed"],
      ["refuses the code under another status", () => jsonResponse(403, { error: "invalid_grant", error_description: "used" }), "failed"],
      ["is rate limiting", () => jsonResponse(429, { error: "slow_down" }), "unavailable"],
      ["is rate limiting with no body to speak of", () => new Response("slow down", { status: 429 }), "unavailable"],
      ["fails on its side", () => jsonResponse(500, { error: "invalid_grant" }), "unavailable"],
      ["is down behind its proxy", () => new Response("<html>bad gateway</html>", { status: 502 }), "unavailable"],
      ["answers with something that is not JSON", () => new Response("<html></html>", { status: 200 }), "unavailable"],
      ["answers with nothing", () => new Response(null, { status: 200 }), "unavailable"],
      ["answers with a JSON array", () => jsonResponse(200, [{ access_token: "x" }]), "unavailable"],
      ["answers with a JSON null", () => jsonResponse(200, null), "unavailable"],
      ["refuses with something that is not JSON", () => new Response("bad request", { status: 400 }), "unavailable"],
      ["answers with no tokens", () => jsonResponse(200, {}), "unavailable"],
      ["answers with no ID token", () => jsonResponse(200, { access_token: issuer().accessToken() }), "unavailable"],
      ["answers with no access token", () => jsonResponse(200, { id_token: issuer().idToken() }), "unavailable"],
      ["answers with tokens that are not strings", () => jsonResponse(200, { access_token: 5, id_token: null }), "unavailable"],
    ];
    for (const [what, answer, error] of answers) {
      test(`${what}`, async () => {
        const { client, started } = await begin();
        issuer().state.token = answer;
        const seen = tokenRequests().length;
        expectBackToSignIn(await callback(client, started), error);
        expect(tokenRequests()).toHaveLength(seen + 1);
        expect(client.cookies.has("session_id")).toBe(false);
      });
    }

    test("redirects: the redirect is not followed", async () => {
      const { client, started } = await begin();
      issuer().state.token = () =>
        new Response(null, { status: 307, headers: { Location: `${issuer().backChannelUrl}/oauth/elsewhere` } });
      expectBackToSignIn(await callback(client, started), "unavailable");
      expect(issuer().seen("/oauth/elsewhere")).toEqual([]);
    });

    test("cannot be reached", async () => {
      const { client, started } = await begin();
      issuer().setUnreachable(true);
      try {
        expectBackToSignIn(await callback(client, started), "unavailable");
      } finally {
        issuer().setUnreachable(false);
      }
      // Back again, the next sign-in completes.
      await ssoSignIn(stack, stack.anonymous(), { claims: newcomer("after-outage") });
    });

    test("answers every request with a 503", async () => {
      const { client, started } = await begin();
      issuer().state.down = true;
      expectBackToSignIn(await callback(client, started), "unavailable");
    });

    test("does not answer within five seconds", async () => {
      const { client, started } = await begin();
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      issuer().state.token = async () => {
        await held;
        return jsonResponse(200, tokenAnswer(stack, started));
      };
      const before = Date.now();
      try {
        expectBackToSignIn(await callback(client, started), "unavailable");
      } finally {
        release();
      }
      const waited = Date.now() - before;
      expect(waited).toBeGreaterThanOrEqual(4_500);
      expect(waited).toBeLessThan(9_000);
    }, 20_000);

    test("refuses the client itself: that is a fault here, and raises the alarm", async () => {
      const { client, started } = await begin();
      issuer().state.token = () => jsonResponse(401, { error: "invalid_client" });
      const first = await callback(client, started);
      expect(first.status).toBe(500);
      expect(first.json).toEqual(SERVER_ERROR);
      // Nothing is cleared and nobody is signed in.
      expect(first.setCookies).toEqual([]);
      const alarm = await stack.waitFor(
        () => stack.upstream.discord.alarms().find((a) => a.title === "🚨 Budget Server Error: Route Error: GET /auth/callback"),
        { what: "the route error alarm" },
      );
      expect(alarm.description).toBe("**Error:** the token endpoint refused the request (invalid_client)");

      // An error code that is not one is left out of the message: the status stands in.
      issuer().state.token = () => jsonResponse(400, { error: "no such code!" });
      const second = await callback(client, started);
      expect(second.status).toBe(500);
      await stack.waitForLog("the token endpoint refused the request (400)");
      issuer().state.token = () => jsonResponse(418, { error: 5 });
      expect((await callback(client, started)).status).toBe(500);
      await stack.waitForLog("the token endpoint refused the request (418)");
      issuer().state.token = () => jsonResponse(400, { error: "x".repeat(65) });
      expect((await callback(client, started)).status).toBe(500);
      issuer().state.token = () => jsonResponse(400, { error: "temporarily_unavailable.v2-x" });
      expect((await callback(client, started)).status).toBe(500);
      await stack.waitForLog("the token endpoint refused the request (temporarily_unavailable.v2-x)");
    });
  });

  describe("tokens that do not check out", () => {
    const issuer = () => stack.upstream.issuer;
    type Answer = (started: { nonce: string }) => Record<string, unknown>;
    const withAccess = (make: () => string): Answer => (started) => ({ ...tokenAnswer(stack, started), access_token: make() });
    const withId = (make: (nonce: string) => string): Answer => (started) => ({
      ...tokenAnswer(stack, started),
      id_token: make(started.nonce),
    });
    const b64 = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
    const parts = (token: string) => token.split(".") as [string, string, string];

    const refused: [string, Answer][] = [
      // The access token.
      ["an access token that is not a JWT", withAccess(() => "not-a-jwt")],
      ["an empty access token", withAccess(() => "")],
      ["an access token of two segments", withAccess(() => parts(issuer().accessToken()).slice(0, 2).join("."))],
      ["an access token of four segments", withAccess(() => `${issuer().accessToken()}.AAAA`)],
      ["an access token with a character outside base64url", withAccess(() => `${issuer().accessToken()}=`)],
      ["an access token whose header is not JSON", withAccess(() => [b64("nope"), ...parts(issuer().accessToken()).slice(1)].join("."))],
      ["an access token whose header is a JSON array", withAccess(() => [b64(["EdDSA"]), ...parts(issuer().accessToken()).slice(1)].join("."))],
      ["an access token whose payload is not JSON", withAccess(() => {
        const [h, , s] = parts(issuer().accessToken());
        return `${h}.${b64("nope")}.${s}`;
      })],
      ["an unsigned access token", withAccess(() => issuer().accessToken({}, { alg: "none" }))],
      ["an access token claiming HS256", withAccess(() => issuer().accessToken({}, { alg: "HS256" }))],
      ["an access token claiming RS256", withAccess(() => issuer().accessToken({}, { alg: "RS256" }))],
      ["an access token with the algorithm in another letter case", withAccess(() => issuer().accessToken({}, { alg: "eddsa" }))],
      ["an access token with no algorithm", withAccess(() => issuer().accessToken({}, { alg: undefined }))],
      ["an ID token passed off as an access token", withAccess(() => issuer().accessToken({}, { typ: "JWT" }))],
      ["an access token with no type", withAccess(() => issuer().accessToken({}, { typ: undefined }))],
      ["an access token with a type that is not a string", withAccess(() => issuer().accessToken({}, { typ: 5 }))],
      ["an access token with a media type for a type", withAccess(() => issuer().accessToken({}, { typ: "application/at+jwt" }))],
      ["an access token with a critical header", withAccess(() => issuer().accessToken({}, { crit: ["exp"] }))],
      ["an access token with a null critical header", withAccess(() => issuer().accessToken({}, { crit: null }))],
      ["an access token with no key id", withAccess(() => issuer().accessToken({}, { kid: undefined }))],
      ["an access token with a key id that is not a string", withAccess(() => issuer().accessToken({}, { kid: 1 }))],
      ["an access token signed by someone else's key", withAccess(() => issuer().foreignKeyToken(
        { iss: ISSUER, sub: "usr_alice", aud: CLIENT_ID, iat: nowS(), exp: nowS() + 600, sid: "s", username: "alice", name: "A", role: "user" },
        { alg: "EdDSA", typ: "at+jwt", kid: "k1" },
      ))],
      ["an access token whose payload was changed after signing", withAccess(() => {
        const [h, , s] = parts(issuer().accessToken());
        const [, p] = parts(issuer().accessToken({ role: "admin" }));
        return `${h}.${p}.${s}`;
      })],
      ["an access token with a cut signature", withAccess(() => issuer().accessToken().slice(0, -4))],
      ["an access token with a signature that is too long", withAccess(() => `${issuer().accessToken()}AAAA`)],
      ["an access token from another issuer", withAccess(() => issuer().accessToken({ iss: "https://other.example.test" }))],
      ["an access token whose issuer has a trailing slash", withAccess(() => issuer().accessToken({ iss: `${ISSUER}/` }))],
      ["an access token with no issuer", withAccess(() => issuer().accessToken({ iss: undefined }))],
      ["an access token for another audience", withAccess(() => issuer().accessToken({ aud: "another-app" }))],
      ["an access token for other audiences", withAccess(() => issuer().accessToken({ aud: ["another-app", "third-app"] }))],
      ["an access token with no audience", withAccess(() => issuer().accessToken({ aud: undefined }))],
      ["an access token with an audience that is a number", withAccess(() => issuer().accessToken({ aud: 5 }))],
      ["an access token issued in the future", withAccess(() => issuer().accessToken({ iat: nowS() + 120 }))],
      ["an access token with no issue time", withAccess(() => issuer().accessToken({ iat: undefined }))],
      ["an access token whose issue time is text", withAccess(() => issuer().accessToken({ iat: String(nowS()) }))],
      ["an expired access token", withAccess(() => issuer().accessToken({ iat: nowS() - 900, exp: nowS() - 120 }))],
      ["an access token with no expiry", withAccess(() => issuer().accessToken({ exp: undefined }))],
      ["an access token whose expiry is text", withAccess(() => issuer().accessToken({ exp: String(nowS() + 600) }))],
      ...["sub", "sid", "username", "name", "role"].flatMap((claim): [string, Answer][] => [
        [`an access token with no ${claim}`, withAccess(() => issuer().accessToken({ [claim]: undefined }))],
        [`an access token whose ${claim} is not text`, withAccess(() => issuer().accessToken({ [claim]: 5 }))],
        [`an access token whose ${claim} is null`, withAccess(() => issuer().accessToken({ [claim]: null }))],
      ]),
      // The ID token.
      ["an ID token that is not a JWT", withId(() => "not-a-jwt")],
      ["an access token passed off as an ID token", withId((nonce) => issuer().idToken({ nonce }, { typ: "at+jwt" }))],
      ["an ID token with no type", withId((nonce) => issuer().idToken({ nonce }, { typ: undefined }))],
      ["an unsigned ID token", withId((nonce) => issuer().idToken({ nonce }, { alg: "none" }))],
      ["an ID token signed by someone else's key", withId((nonce) => issuer().foreignKeyToken(
        { iss: ISSUER, sub: "usr_alice", aud: CLIENT_ID, iat: nowS(), exp: nowS() + 600, nonce },
        { alg: "EdDSA", typ: "JWT", kid: "k1" },
      ))],
      ["an ID token from another issuer", withId((nonce) => issuer().idToken({ nonce, iss: "https://other.example.test" }))],
      ["an ID token for another client", withId((nonce) => issuer().idToken({ nonce, aud: "another-app" }))],
      ["an ID token for several audiences that names no authorized party", withId((nonce) => issuer().idToken({ nonce, aud: [CLIENT_ID, "another-app"] }))],
      ["an ID token for several audiences authorized to another party", withId((nonce) => issuer().idToken({ nonce, aud: [CLIENT_ID, "another-app"], azp: "another-app" }))],
      ["an ID token with no nonce", withId(() => issuer().idToken({}))],
      ["an ID token with another sign-in's nonce", withId(() => issuer().idToken({ nonce: "another-nonce" }))],
      ["an ID token whose nonce is not text", withId(() => issuer().idToken({ nonce: 5 }))],
      ["an ID token naming another subject", withId((nonce) => issuer().idToken({ nonce, sub: "usr_mallory" }))],
      ["an ID token with no subject", withId((nonce) => issuer().idToken({ nonce, sub: undefined }))],
      ["an expired ID token", withId((nonce) => issuer().idToken({ nonce, iat: nowS() - 900, exp: nowS() - 120 }))],
      ["an ID token issued in the future", withId((nonce) => issuer().idToken({ nonce, iat: nowS() + 120 }))],
    ];
    for (const [what, answer] of refused) {
      test(`refuses ${what}`, async () => {
        const { client, started } = await begin();
        issuer().state.token = () => jsonResponse(200, answer(started));
        const users = (await stack.db.rows("users")).length;
        expectBackToSignIn(await callback(client, started), "failed");
        expect(client.cookies.has("session_id")).toBe(false);
        expect(await stack.db.rows("users")).toHaveLength(users);
      });
    }

    const accepted: [string, (claims: Record<string, unknown>) => Answer][] = [
      ["an access token whose type is in another letter case", (claims) => (started) => ({
        ...tokenAnswer(stack, started, { claims }),
        access_token: issuer().accessToken(claims, { typ: "AT+JWT" }),
      })],
      ["an access token for several audiences, this app among them", (claims) => (started) =>
        tokenAnswer(stack, started, { claims: { ...claims, aud: ["another-app", CLIENT_ID] } })],
      ["an access token issued a moment ahead of the clock", (claims) => (started) =>
        tokenAnswer(stack, started, { claims: { ...claims, iat: nowS() + 20 } })],
      ["an access token that expired a moment ago", (claims) => (started) =>
        tokenAnswer(stack, started, { claims: { ...claims, iat: nowS() - 600, exp: nowS() - 20 } })],
      ["an ID token whose type is lower case", (claims) => (started) => ({
        ...tokenAnswer(stack, started, { claims }),
        id_token: issuer().idToken({ sub: claims.sub, nonce: started.nonce }, { typ: "jwt" }),
      })],
      ["an ID token for several audiences authorized to this client", (claims) => (started) =>
        tokenAnswer(stack, started, { claims, idClaims: { aud: ["another-app", CLIENT_ID], azp: CLIENT_ID } })],
      ["an ID token for this client alone, in a list", (claims) => (started) =>
        tokenAnswer(stack, started, { claims, idClaims: { aud: [CLIENT_ID] } })],
      ["an ID token that expired a moment ago", (claims) => (started) =>
        tokenAnswer(stack, started, { claims, idClaims: { iat: nowS() - 600, exp: nowS() - 20 } })],
      ["tokens with claims it has no use for", (claims) => (started) =>
        tokenAnswer(stack, started, { claims: { ...claims, extra: { nested: [1, 2] }, scope: "openid" }, idClaims: { amr: ["pwd"], at_hash: "x" } })],
    ];
    for (const [what, answer] of accepted) {
      test(`accepts ${what}`, async () => {
        const { client, started } = await begin();
        const claims = newcomer("accepted");
        issuer().state.token = () => jsonResponse(200, answer(claims)(started));
        expectSignedIn(await callback(client, started));
        expect((await whoAmI(client))?.username).toBe(claims.username);
      });
    }

    test("verifies against the provider's keys, fetched once over the back channel", async () => {
      await ssoSignIn(stack, stack.anonymous(), { claims: newcomer("keys") });
      await ssoSignIn(stack, stack.anonymous(), { claims: newcomer("keys") });
      const requests = issuer().seen("/.well-known/jwks.json");
      expect(requests).toHaveLength(1);
      expect(requests[0].host).toBe(ISSUER_HOST);
      expect(requests[0].method).toBe("GET");
      expect(requests[0].headers.accept).toBe("application/json");
      expect(requests[0].headers.authorization).toBeUndefined();
    });
  });

  describe("a person the provider gives no role here", () => {
    test("is sent back with no access, and no user is made for them", async () => {
      const { client, started } = await begin();
      const who = newcomer("roleless");
      expectBackToSignIn(await finishSsoLogin(stack, client, started, { claims: { ...who, role: "" } }), "no_access");
      expect(await userBySub(who.sub)).toBeUndefined();
      expect(client.cookies.has("session_id")).toBe(false);
    });

    test("any role at all is access", async () => {
      for (const role of ["viewer", "0", "false", " "]) {
        const { client, started } = await begin();
        expectSignedIn(await finishSsoLogin(stack, client, started, { claims: { ...newcomer("role"), role } }));
      }
    });
  });

  describe("which user it is", () => {
    const signIn = async (claims: Record<string, unknown>, idClaims: Record<string, unknown> = {}) => {
      const { client, started } = await begin();
      return { client, result: await finishSsoLogin(stack, client, started, { claims, idClaims }) };
    };

    test("the user already linked to the subject, whatever the token calls them", async () => {
      const linked = await createUser(stack, "renamed-since", { auth_sub: "usr_known", email: "known@example.com" });
      const bystander = await createUser(stack, "has-that-email", { email: "other@example.com" });
      const users = (await stack.db.rows("users")).length;
      const { client, result } = await signIn(
        { sub: "usr_known", username: "local-carol", sid: "ses_known" },
        { email: "other@example.com" },
      );
      expectSignedIn(result);
      expect(await whoAmI(client)).toEqual({ user_id: linked.user_id, username: "renamed-since" });
      expect(await stack.db.rows("users")).toHaveLength(users);
      expect((await userByName(bystander.username))?.auth_sub).toBeNull();
      // Neither the name nor the email of the account follows the token.
      expect(await userByName("renamed-since")).toMatchObject({ email: "known@example.com", auth_sub: "usr_known" });
    });

    test("the local account AUTH_LINK_USERS names for the provider's username, linked on first sign-in", async () => {
      const local = await createUser(stack, "local-carol", { email: "carol@local.example" });
      const { client, result } = await signIn({ sub: "usr_carol", username: "carol", sid: "ses_carol" }, { email: "carol@idp.example" });
      expectSignedIn(result);
      expect(await whoAmI(client)).toEqual({ user_id: local.user_id, username: "local-carol" });
      expect(await userByName("local-carol")).toMatchObject({ auth_sub: "usr_carol", email: "carol@local.example" });
      expect(await userByName("carol")).toBeUndefined();
      // The password is kept, though it no longer signs in while single sign-on is on.
      expect((await userByName("local-carol"))?.password).toBeTruthy();

      // From then on the link is the subject, not the name.
      const again = await signIn({ sub: "usr_carol", username: "carol-renamed", sid: "ses_carol_2" });
      expect(await whoAmI(again.client)).toEqual({ user_id: local.user_id, username: "local-carol" });
    });

    test("AUTH_LINK_USERS is followed before the email, and its entries are trimmed", async () => {
      const local = await createUser(stack, "local-dave");
      const byEmail = await createUser(stack, "dave-by-email", { email: "dave@example.com" });
      const { client, result } = await signIn({ sub: "usr_dave", username: "dave", sid: "ses_dave" }, { email: "dave@example.com" });
      expectSignedIn(result);
      expect(await whoAmI(client)).toEqual({ user_id: local.user_id, username: "local-dave" });
      expect((await userByName(byEmail.username))?.auth_sub).toBeNull();
    });

    test("a link to an account that does not exist falls through to a new user", async () => {
      const { client, result } = await signIn({ sub: "usr_erin", username: "erin", sid: "ses_erin" }, { email: "erin@example.com" });
      expectSignedIn(result);
      expect((await whoAmI(client))?.username).toBe("erin");
      expect(await userByName("ghost-account")).toBeUndefined();
      expect(await userByName("erin")).toMatchObject({ auth_sub: "usr_erin", email: "erin@example.com", password: null });
    });

    test("a link to an account that is someone else's already does not take it over", async () => {
      const taken = await createUser(stack, "linked-account", { auth_sub: "usr_someone_else" });
      const { client, result } = await signIn({ sub: "usr_frank", username: "frank", sid: "ses_frank" }, { email: undefined });
      expectSignedIn(result);
      expect((await whoAmI(client))?.username).toBe("frank");
      expect((await userByName(taken.username))?.auth_sub).toBe("usr_someone_else");
    });

    test("the unlinked account with the ID token's email, in any letter case and trimmed", async () => {
      const local = await createUser(stack, "mail-matched", { email: "Mixed.Case@Example.COM" });
      const { client, result } = await signIn(
        { sub: "usr_mail", username: "someone-new", sid: "ses_mail" },
        { email: "  mixed.case@EXAMPLE.com\t", email_verified: false },
      );
      expectSignedIn(result);
      expect(await whoAmI(client)).toEqual({ user_id: local.user_id, username: "mail-matched" });
      expect(await userByName("mail-matched")).toMatchObject({ auth_sub: "usr_mail", email: "Mixed.Case@Example.COM" });
      expect(await userByName("someone-new")).toBeUndefined();
    });

    test("an account with the email that is someone else's is left alone: a new user is made, without the email", async () => {
      const taken = await createUser(stack, "mail-taken", { email: "taken@example.com", auth_sub: "usr_mail_owner" });
      const { client, result } = await signIn({ sub: "usr_mail_2", username: "mail-second", sid: "ses_mail_2" }, { email: "TAKEN@example.com" });
      expectSignedIn(result);
      expect((await whoAmI(client))?.username).toBe("mail-second");
      expect(await userByName("mail-second")).toMatchObject({ auth_sub: "usr_mail_2", email: null, password: null });
      expect((await userByName(taken.username))?.auth_sub).toBe("usr_mail_owner");
    });

    test("a deleted account with the email is not linked, and keeps the email to itself", async () => {
      const deleted = await createUser(stack, "mail-deleted", { email: "gone@example.com" });
      await stack.db.query("UPDATE users SET is_deleted = TRUE WHERE user_id = $1", [deleted.user_id]);
      const { client, result } = await signIn({ sub: "usr_mail_3", username: "mail-third", sid: "ses_mail_3" }, { email: "gone@example.com" });
      expectSignedIn(result);
      expect((await whoAmI(client))?.username).toBe("mail-third");
      expect(await userByName("mail-third")).toMatchObject({ auth_sub: "usr_mail_3", email: null });
      expect(await userByName("mail-deleted")).toMatchObject({ auth_sub: null, is_deleted: true });
    });

    test("an email that is not text, or empty, is no email", async () => {
      const emails: unknown[] = [undefined, null, 5, ["a@example.com"], "", "   "];
      for (const [index, email] of emails.entries()) {
        const claims = { sub: `usr_no_mail_${index}`, username: `no-mail-${index}`, sid: `ses_no_mail_${index}` };
        expectSignedIn((await signIn(claims, { email })).result);
        expect(await userByName(claims.username)).toMatchObject({ auth_sub: claims.sub, email: null });
      }
    });

    test("signing in again is the same user, with a session of its own", async () => {
      const claims = { sub: "usr_again", username: "again", sid: "ses_again_1" };
      const first = await signIn(claims);
      const second = await signIn({ ...claims, sid: "ses_again_2" }, { email: "changed@example.com" });
      expect(await whoAmI(second.client)).toEqual(await whoAmI(first.client));
      expect(await stack.db.rows("users", { auth_sub: "usr_again" })).toHaveLength(1);
      // The email of the first sign-in stands.
      expect((await userByName("again"))?.email).toBe("usr_again@example.test");
      const sessions = await stack.db.rows("sessions", { user_username: "again" }, "auth_sid");
      expect(sessions.map((session) => session.auth_sid)).toEqual(["ses_again_1", "ses_again_2"]);
    });

    test("a username a local account already has is refused, not guessed at", async () => {
      await createUser(stack, "name-taken");
      for (const username of ["admin", "demo", "name-taken"]) {
        const sub = `usr_wants_${username}`;
        const { client, result } = await signIn({ sub, username, sid: `ses_wants_${username}` }, { email: `${username}@nowhere.example` });
        expectBackToSignIn(result, "account_exists");
        expect(client.cookies.has("session_id")).toBe(false);
        expect(await userBySub(sub)).toBeUndefined();
        expect((await userByName(username))?.auth_sub).toBeNull();
      }
      await stack.waitForLog("Single sign-on refused");
    });

    test("a username a deleted account still holds is refused too", async () => {
      const deleted = await createUser(stack, "name-deleted");
      await stack.db.query("UPDATE users SET is_deleted = TRUE WHERE user_id = $1", [deleted.user_id]);
      const { result } = await signIn({ sub: "usr_wants_deleted", username: "name-deleted", sid: "ses_wants_deleted" });
      expectBackToSignIn(result, "account_exists");
      expect(await userBySub("usr_wants_deleted")).toBeUndefined();
    });

    test("usernames differ by letter case, as local ones do", async () => {
      const { client, result } = await signIn({ sub: "usr_upper", username: "Admin", sid: "ses_upper" }, { email: undefined });
      expectSignedIn(result);
      expect((await whoAmI(client))?.username).toBe("Admin");
    });
  });

  test("what cannot be answered or stored fails as a server error", async () => {
    // A place to return to that a Location header cannot carry: the session is
    // made, then the answer fails, so no cookie for it is ever sent.
    const { client, started } = await begin({ returnTo: "/日本/予算" });
    const who = newcomer("unsendable");
    const result = await finishSsoLogin(stack, client, started, { claims: who });
    expect(result.status).toBe(500);
    expect(result.json).toEqual(SERVER_ERROR);
    expect(result.setCookies).toEqual([]);
    await stack.waitForLog("Header 'Location' has invalid value");
    expect(await stack.db.rows("sessions", { auth_sid: who.sid })).toHaveLength(1);
    expect(await userBySub(who.sub)).toBeDefined();

    // A username longer than the column.
    const long = await begin();
    const longName = { sub: "usr_long_name", username: "n".repeat(256), sid: "ses_long_name" };
    const refused = await finishSsoLogin(stack, long.client, long.started, { claims: longName, idClaims: { email: undefined } });
    expect(refused.status).toBe(500);
    expect(refused.json).toEqual(SERVER_ERROR);
    expect(await userBySub("usr_long_name")).toBeUndefined();
    await stack.waitForLog("value too long for type character varying(255)");
  });
});
