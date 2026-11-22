/**
 * Single sign-on's settings: off unless `AUTH_ISSUER` is set, refused at boot
 * when anything about them is wrong, and what the less common valid ones
 * (no back channel, a redirect URI derived from `HOST_NAME`, an audience of
 * its own, an issuer on localhost) change.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  ADMIN_PASSWORD,
  CLIENT_ID,
  CLIENT_SECRET,
  ISSUER,
  ISSUER_HOST,
  ISSUER_PUBLIC_HOST,
  REDIRECT_URI,
  createUser,
  jsonResponse,
  startStack,
  type ApiClient,
  type ApiResult,
  type Stack,
} from "../harness";
import { startExpectingFailure } from "../harness/boot";
import { CLEAR_LOGIN_COOKIE, finishSsoLogin, sessionRow, ssoSignIn, startSsoLogin } from "../harness/sso";

// Tests here start, restart and wait on real server processes: give each the suite's 30 seconds
// rather than the runner's default of five.
setDefaultTimeout(30_000);

const NOT_AUTHENTICATED = { status: "failed", message: "Not authenticated." };
const NOT_FOUND = { status: "error", message: "Not Found" };
const whoAmI = async (client: ApiClient) => (await client.get<{ user?: { username: string } }>("/login")).body.user?.username;
const ssoMode = async (stack: Stack) => (await stack.anonymous().get<{ sso: unknown }>("/login")).body.sso;

describe("with single sign-on off", () => {
  let stack: Stack;
  beforeAll(async () => {
    // Everything but the issuer is set, and wrongly: with no issuer none of it is read.
    stack = await startStack({
      env: {
        AUTH_ISSUER: "   ",
        AUTH_CLIENT_ID: "",
        AUTH_REDIRECT_URI: "not a url",
        AUTH_BACKCHANNEL_URL: "ftp://nowhere",
        AUTH_LOCAL_LOGIN: "maybe",
        AUTH_LINK_USERS: "this is not a list",
      },
    });
  });
  afterAll(() => stack.stop());

  const ssoRoutes: [string, string][] = [
    ["GET", "/auth/login"],
    ["GET", "/auth/callback"],
    ["POST", "/auth/events"],
  ];

  test("password sign-in is the way in", async () => {
    expect(await ssoMode(stack)).toEqual({ enabled: false, localLogin: true });
    expect(stack.logs.some((line) => line.includes("Single sign-on is on"))).toBe(false);
  });

  test("its routes are not public: an anonymous caller is told to sign in, as on any unknown path", async () => {
    for (const [method, path] of ssoRoutes) {
      const result = await stack.anonymous().request(method, path, { query: { code: "c", state: "s", returnTo: "/x" } });
      expect(result.status).toBe(401);
      expect(result.json).toEqual(NOT_AUTHENTICATED);
      expect(result.setCookies).toEqual([]);
      expect(result.headers.get("location")).toBeNull();
    }
  });

  test("its routes answer a signed-in caller as a path nothing serves", async () => {
    const client = await stack.login();
    const sid = client.cookies.get("session_id");
    for (const [method, path] of ssoRoutes) {
      const result = await client.request(method, path, method === "POST" ? { rawBody: "a.b.c" } : {});
      expect(result.status).toBe(404);
      expect(result.json).toEqual(NOT_FOUND);
      expect(result.headers.get("content-type")).toBe("application/json");
      expect(result.headers.get("location")).toBeNull();
      // They are routes all the same, so the answer refreshes the session like any route's.
      expect(result.setCookies).toEqual([`session_id=${sid}; Max-Age=604800; Path=/; HttpOnly; SameSite=Strict`]);
    }
    // A path with no route at all is answered before the session is saved.
    const unknown = await client.get("/auth/nothing-here");
    expect(unknown.status).toBe(404);
    expect(unknown.json).toEqual(NOT_FOUND);
    expect(unknown.setCookies).toEqual([]);
  });

  test("signing out is plain: there is no provider to sign out of", async () => {
    const client = await stack.login();
    const result = await client.delete("/login");
    expect(result.json).toEqual({ status: "success" });
  });
});

describe("turning single sign-on on and off again", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(() => stack.stop());

  test("ends the sessions of the way in that was turned off, and gives linked accounts their passwords back", async () => {
    // Off: a password session, and a local account with an email to be linked by.
    const local = await createUser(stack, "migrating", { email: "migrating@example.test" });
    const passwordSession = await stack.login();
    expect(await whoAmI(passwordSession)).toBe("admin");

    // On, with single sign-on the only way in: the password session ends.
    await stack.restart(stack.upstream.issuer.env());
    await stack.waitForLog("Single sign-on is on");
    expect(stack.logs.find((line) => line.includes("Single sign-on is on"))).toContain(`{"issuer":"${ISSUER}","localLogin":false}`);
    expect(await ssoMode(stack)).toEqual({ enabled: true, localLogin: false });
    const passwordSid = passwordSession.cookies.get("session_id");
    expect(await whoAmI(passwordSession)).toBeUndefined();
    expect(await stack.db.rows("sessions", { session_id: passwordSid })).toEqual([]);
    const refused = await stack.anonymous().post("/login", { username: "admin", password: ADMIN_PASSWORD });
    expect(refused.status).toBe(403);

    // The account signs in through the provider and is linked by its email.
    const sso = stack.anonymous();
    await ssoSignIn(stack, sso, {
      claims: { sub: "usr_migrating", username: "migrating-at-idp", sid: "ses_migrating" },
      idClaims: { email: "migrating@example.test" },
    });
    expect(await whoAmI(sso)).toBe("migrating");

    // Off again: the single sign-on session ends, and the linked account's password signs in as before.
    const off = Object.fromEntries(Object.keys(stack.upstream.issuer.env()).map((name) => [name, undefined]));
    await stack.restart(off);
    expect(await ssoMode(stack)).toEqual({ enabled: false, localLogin: true });
    const ssoSid = sso.cookies.get("session_id");
    expect(await whoAmI(sso)).toBeUndefined();
    expect(await stack.db.rows("sessions", { session_id: ssoSid })).toEqual([]);
    const back = await stack.anonymous().post("/login", { username: local.username, password: local.password });
    expect(back.json).toEqual({ status: "success", body: { user_id: local.user_id, username: local.username } });
    // The link itself is kept for when it is turned on again.
    expect((await stack.db.one("SELECT auth_sub FROM users WHERE user_id = $1", [local.user_id]))?.auth_sub).toBe("usr_migrating");
  });

  test("AUTH_LOCAL_LOGIN is read as a yes or a no, in any letter case", async () => {
    const spellings: [string, boolean][] = [
      [" YES ", true],
      ["On", true],
      ["1", true],
      ["TRUE", true],
      ["off", false],
      ["No", false],
      ["0", false],
      ["False", false],
      ["  ", false],
    ];
    for (const [value, localLogin] of spellings) {
      await stack.restart({ ...stack.upstream.issuer.env(), AUTH_LOCAL_LOGIN: value });
      expect(await ssoMode(stack)).toEqual({ enabled: true, localLogin });
    }
  });
});

describe("a configuration with no back channel, a derived redirect URI and an audience of its own", () => {
  let stack: Stack;
  const AUDIENCE = "budget-api";
  beforeAll(async () => {
    stack = await startStack({
      sso: {
        AUTH_AUDIENCE: AUDIENCE,
        // A next-line character is not white space to JavaScript, so this is one well-formed entry.
        AUTH_LINK_USERS: "next\u0085line=nel",
      },
      // The redirect URI comes from HOST_NAME, and the provider is called at its own address.
      env: { AUTH_REDIRECT_URI: undefined, AUTH_BACKCHANNEL_URL: undefined, HOST_NAME: "Budget.Example.Test" },
    });
  });
  afterAll(() => stack.stop());
  const issuer = () => stack.upstream.issuer;

  test("sends the browser off with the redirect URI made from HOST_NAME, having read discovery at the issuer itself", async () => {
    const started = await startSsoLogin(stack.anonymous());
    expect(started.location.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(started.location.searchParams.get("client_id")).toBe(CLIENT_ID);
    const discovery = issuer().seen("/.well-known/openid-configuration");
    expect(discovery).toHaveLength(1);
    expect(discovery[0].host).toBe(ISSUER_PUBLIC_HOST);
    expect(stack.upstream.hub.seen(ISSUER_HOST)).toEqual([]);
  });

  test("signs in on tokens for its audience, with the ID token still for the client", async () => {
    const client = stack.anonymous();
    const started = await startSsoLogin(client);
    const claims = { sub: "usr_audience", username: "audience", sid: "ses_audience", aud: AUDIENCE };
    const result = await finishSsoLogin(stack, client, started, { claims });
    expect(result.status).toBe(302);
    expect(result.headers.get("location")).toBe("/");
    expect(await whoAmI(client)).toBe("audience");

    const token = issuer().seen("/oauth/token").at(-1);
    expect(token?.host).toBe(ISSUER_PUBLIC_HOST);
    expect(token?.form.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(token?.headers.authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`);
    expect(issuer().seen("/.well-known/jwks.json").map((request) => request.host)).toEqual([ISSUER_PUBLIC_HOST]);

    // Signing out names the app's own origin to come back to.
    const out = await client.delete("/login");
    expect(out.json).toEqual({
      status: "success",
      body: { logoutUrl: `${ISSUER}/logout?client_id=${CLIENT_ID}&post_logout_redirect_uri=${encodeURIComponent("https://budget.example.test/")}` },
    });
    await stack.waitFor(() => issuer().seen("/oauth/revoke").length > 0, { what: "the revocation" });
    expect(issuer().seen("/oauth/revoke")[0].host).toBe(ISSUER_PUBLIC_HOST);
  });

  test("refuses an access token for the client id, and an ID token for the audience", async () => {
    const forClient = stack.anonymous();
    const first = await startSsoLogin(forClient);
    const refused = await finishSsoLogin(stack, forClient, first, { claims: { sub: "usr_wrong_aud", username: "wrong-aud" } });
    expect(refused.headers.get("location")).toBe("/login?sso_error=failed");
    expect(refused.setCookies).toEqual([CLEAR_LOGIN_COOKIE]);

    const forAudience = stack.anonymous();
    const second = await startSsoLogin(forAudience);
    const alsoRefused = await finishSsoLogin(stack, forAudience, second, {
      claims: { sub: "usr_wrong_aud", username: "wrong-aud", aud: AUDIENCE },
      idClaims: { aud: AUDIENCE },
    });
    expect(alsoRefused.headers.get("location")).toBe("/login?sso_error=failed");
    expect(await stack.db.rows("users", { auth_sub: "usr_wrong_aud" })).toEqual([]);
  });

  test("takes security events for its audience only", async () => {
    const send = (token: string): Promise<ApiResult> =>
      stack.anonymous().request("POST", "/auth/events", { rawBody: token, headers: { "Content-Type": "application/secevent+jwt" } });
    const event = { "invite.accepted": { invite: "inv_1", sub: "usr_nobody" } };
    expect((await send(issuer().eventToken(event, { aud: AUDIENCE }))).status).toBe(202);
    expect((await send(issuer().eventToken(event, { aud: [CLIENT_ID, AUDIENCE] }))).status).toBe(202);
    expect((await send(issuer().eventToken(event))).status).toBe(400);
  });

  test("re-checks a session at the issuer itself, and serves it while the issuer cannot be reached", async () => {
    const client = stack.anonymous();
    const claims = { sub: "usr_direct", username: "direct", sid: "ses_direct", aud: AUDIENCE };
    await ssoSignIn(stack, client, { claims, refreshToken: "rt-direct" });
    const due = () =>
      stack.db.query("UPDATE sessions SET auth_recheck_at = $2 WHERE session_id = $1", [client.cookies.get("session_id"), new Date(Date.now() - 30_000)]);
    const refreshes = () => issuer().seen("/oauth/token").filter((request) => request.form.get("grant_type") === "refresh_token");

    await due();
    issuer().state.token = () => jsonResponse(200, { access_token: issuer().accessToken(claims) });
    expect(await whoAmI(client)).toBe("direct");
    expect(refreshes().map((request) => request.host)).toEqual([ISSUER_PUBLIC_HOST]);

    await due();
    stack.upstream.hub.setDown(ISSUER_PUBLIC_HOST, true);
    try {
      expect(await whoAmI(client)).toBe("direct");
      expect(((await sessionRow(stack, client))?.auth_recheck_at as Date).getTime()).toBeLessThan(Date.now());
    } finally {
      stack.upstream.hub.setDown(ISSUER_PUBLIC_HOST, false);
    }
    // A token for the client id is not one for this app's audience: a failed re-check, served for now.
    issuer().state.token = () => jsonResponse(200, { access_token: issuer().accessToken({ ...claims, aud: CLIENT_ID }) });
    expect(await whoAmI(client)).toBe("direct");
    expect(((await sessionRow(stack, client))?.auth_recheck_at as Date).getTime()).toBeLessThan(Date.now());
    issuer().reset();
  });

  test("links the account AUTH_LINK_USERS names, next-line character and all", async () => {
    const local = await createUser(stack, "next\u0085line");
    const client = stack.anonymous();
    await ssoSignIn(stack, client, { claims: { sub: "usr_nel", username: "nel", sid: "ses_nel", aud: AUDIENCE } });
    expect(await whoAmI(client)).toBe(local.username);
  });
});

describe("an issuer on localhost over plain http", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack({ sso: true });
  });
  afterAll(() => stack.stop());

  test("is allowed, and is called where it is", async () => {
    const issuer = stack.upstream.issuer;
    const base = issuer.backChannelUrl;
    issuer.state.discovery = {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      jwks_uri: `${base}/.well-known/jwks.json`,
      end_session_endpoint: `${base}/logout`,
    };
    await stack.restart({ AUTH_ISSUER: base, AUTH_BACKCHANNEL_URL: undefined });

    const client = stack.anonymous();
    const started = await startSsoLogin(client);
    expect(`${started.location.origin}${started.location.pathname}`).toBe(`${base}/oauth/authorize`);
    const claims = { iss: base, sub: "usr_local_issuer", username: "local-issuer", sid: "ses_local_issuer" };
    const result = await finishSsoLogin(stack, client, started, { claims, idClaims: { iss: base } });
    expect(result.headers.get("location")).toBe("/");
    expect(await whoAmI(client)).toBe("local-issuer");

    // Tokens naming the https issuer of the other tests are another issuer's here.
    const other = stack.anonymous();
    const again = await startSsoLogin(other);
    const refused = await finishSsoLogin(stack, other, again, { claims: { ...claims, iss: ISSUER }, idClaims: { iss: base } });
    expect(refused.headers.get("location")).toBe("/login?sso_error=failed");
  });
});

describe("a configuration that is wrong", () => {
  const MISCONFIGURED = "Single sign-on is misconfigured:";
  const VALID = {
    AUTH_ISSUER: ISSUER,
    AUTH_CLIENT_ID: CLIENT_ID,
    AUTH_CLIENT_SECRET: "a-secret-that-must-not-be-printed",
    AUTH_REDIRECT_URI: REDIRECT_URI,
  };
  /** The problems the server listed, in order: the `- ` lines after the heading. */
  const problemsOf = (output: string): string[] => {
    const lines = output.split("\n");
    const at = lines.findIndex((line) => line.includes(MISCONFIGURED));
    if (at === -1) return [];
    const problems: string[] = [];
    for (const line of lines.slice(at + 1)) {
      if (!line.startsWith("- ")) break;
      problems.push(line.slice(2));
    }
    return problems;
  };
  const expectRefusal = async (env: Record<string, string | undefined>, problems: string[]) => {
    const failed = await startExpectingFailure(env);
    expect(failed.exitCode).toBe(1);
    expect(problemsOf(failed.output)).toEqual(problems);
    // It stopped at its settings: nothing listened and the database was never tried.
    expect(failed.output).not.toContain("Budget app server is up");
    expect(failed.output).not.toContain("conformance_never_created");
    expect(failed.output).not.toContain("a-secret-that-must-not-be-printed");
    return failed;
  };

  const ISSUER_PROBLEM = "AUTH_ISSUER must be an https URL (http only for localhost) with no query or fragment";
  const REDIRECT_PROBLEM = "AUTH_REDIRECT_URI must be an https URL (http only for localhost) with no fragment";
  const BACK_CHANNEL_PROBLEM = "AUTH_BACKCHANNEL_URL must be an http or https URL with no query or fragment";
  const HOST_NAME_PROBLEM = "HOST_NAME must be a bare host name to derive AUTH_REDIRECT_URI from it; otherwise set AUTH_REDIRECT_URI";

  test("stops the server from starting, with every problem listed at once", async () => {
    await expectRefusal(
      {
        AUTH_ISSUER: "http://auth.example.test",
        AUTH_CLIENT_ID: "   ",
        AUTH_BACKCHANNEL_URL: "ftp://auth.internal",
        AUTH_LOCAL_LOGIN: "sometimes",
        AUTH_LINK_USERS: "a=b, a2=b ,a=c,bad,=x,y=,p=q=r,s t=u, ok = fine ,,",
      },
      [
        ISSUER_PROBLEM,
        "AUTH_CLIENT_ID is required when AUTH_ISSUER is set",
        "AUTH_CLIENT_SECRET is required when AUTH_ISSUER is set",
        "AUTH_REDIRECT_URI is required when HOST_NAME is not set",
        BACK_CHANNEL_PROBLEM,
        "AUTH_LOCAL_LOGIN must be true or false",
        'AUTH_LINK_USERS names auth username "b" more than once',
        'AUTH_LINK_USERS names local account "a" more than once',
        'AUTH_LINK_USERS entry "bad" is not of the form <local account>=<auth username>',
        'AUTH_LINK_USERS entry "=x" is not of the form <local account>=<auth username>',
        'AUTH_LINK_USERS entry "y=" is not of the form <local account>=<auth username>',
        'AUTH_LINK_USERS entry "p=q=r" is not of the form <local account>=<auth username>',
        'AUTH_LINK_USERS entry "s t=u" is not of the form <local account>=<auth username>',
      ],
    );
  });

  test("names a single problem alone, and never prints the secret", async () => {
    await expectRefusal({ ...VALID, AUTH_CLIENT_SECRET: undefined }, ["AUTH_CLIENT_SECRET is required when AUTH_ISSUER is set"]);
    await expectRefusal({ ...VALID, AUTH_LOCAL_LOGIN: "2" }, ["AUTH_LOCAL_LOGIN must be true or false"]);
    await expectRefusal({ ...VALID, AUTH_LINK_USERS: "admin=alice,demo=alice" }, ['AUTH_LINK_USERS names auth username "alice" more than once']);
  });

  const issuers = ["auth.example.test", "https://auth.example.test/?tenant=1", "https://auth.example.test/#top", "http://auth.example.test:8080", "ftp://auth.example.test", "http://localhost.example.test"];
  for (const issuer of issuers) {
    test(`refuses the issuer ${issuer}`, async () => {
      await expectRefusal({ ...VALID, AUTH_ISSUER: issuer }, [ISSUER_PROBLEM]);
    });
  }

  const redirects = ["/api/auth/callback", "http://budget.example.test/api/auth/callback", "https://budget.example.test/api/auth/callback#done", "budget.example.test"];
  for (const redirect of redirects) {
    test(`refuses the redirect URI ${redirect}`, async () => {
      await expectRefusal({ ...VALID, AUTH_REDIRECT_URI: redirect, HOST_NAME: "budget.example.test" }, [REDIRECT_PROBLEM]);
    });
  }

  const hostNames = ["https://budget.example.test", "budget.example.test/app", "budget.example.test:443", "budget example"];
  for (const hostName of hostNames) {
    test(`cannot make a redirect URI from the HOST_NAME ${hostName}`, async () => {
      await expectRefusal({ ...VALID, AUTH_REDIRECT_URI: undefined, HOST_NAME: hostName }, [HOST_NAME_PROBLEM]);
    });
  }

  test("needs a redirect URI or a HOST_NAME", async () => {
    await expectRefusal({ ...VALID, AUTH_REDIRECT_URI: "  ", HOST_NAME: " " }, ["AUTH_REDIRECT_URI is required when HOST_NAME is not set"]);
  });

  const backChannels = ["auth.internal:3000", "ws://auth.internal", "http://auth.internal/?x=1", "http://auth.internal/#x"];
  for (const backChannel of backChannels) {
    test(`refuses the back channel ${backChannel}`, async () => {
      await expectRefusal({ ...VALID, AUTH_BACKCHANNEL_URL: backChannel }, [BACK_CHANNEL_PROBLEM]);
    });
  }
});
