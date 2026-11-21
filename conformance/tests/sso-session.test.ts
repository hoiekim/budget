/**
 * A session while single sign-on is on: the periodic re-check of a single
 * sign-on session with the identity provider, signing out of one, and what
 * becomes of password sign-in and password sessions.
 */
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  ADMIN_PASSWORD,
  CLIENT_ID,
  CLIENT_SECRET,
  ISSUER,
  createUser,
  jsonResponse,
  startStack,
  type ApiClient,
  type ApiResult,
  type Stack,
  type UpstreamRequest,
} from "../harness";
import { makeRecheckDue, sessionRow, ssoSignIn } from "../harness/sso";

// Tests here start, restart and wait on real server processes: give each the suite's 30 seconds
// rather than the runner's default of five.
setDefaultTimeout(30_000);

const BASIC = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`;
const SESSION_CLEARED = "session_id=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict";
const NOT_AUTHENTICATED = { status: "failed", message: "Not authenticated." };
const nowS = () => Math.floor(Date.now() / 1000);

let people = 0;
const signIn = async (stack: Stack, options: { refreshToken?: string | null; role?: string } = {}) => {
  const n = ++people;
  const claims = { sub: `usr_session_${n}`, username: `session-${n}`, sid: `ses_session_${n}`, role: options.role ?? "user" };
  const client = stack.anonymous();
  await ssoSignIn(stack, client, { claims, refreshToken: options.refreshToken === undefined ? `rt-session-${n}` : options.refreshToken });
  return { client, claims, refreshToken: options.refreshToken === undefined ? `rt-session-${n}` : options.refreshToken };
};

const whoAmI = async (client: ApiClient) => (await client.get<{ user?: { username: string } }>("/login")).body.user?.username;

const refreshRequests = (stack: Stack): UpstreamRequest[] =>
  stack.upstream.issuer.seen("/oauth/token").filter((request) => request.form.get("grant_type") === "refresh_token");

/** A password session written straight to the store: the row a sign-in before single sign-on left behind. */
const seedPasswordSession = async (stack: Stack, username: string): Promise<ApiClient> => {
  const sid = crypto.randomUUID();
  await stack.db.insert("sessions", {
    session_id: sid,
    user_user_id: await stack.userId(username),
    user_username: username,
    cookie_original_max_age: 604_800_000,
    cookie_max_age: 604_800_000,
    cookie_expires: new Date(Date.now() + 604_800_000),
    cookie_http_only: true,
    cookie_path: "/",
    cookie_secure: false,
    cookie_same_site: "strict",
  });
  const client = stack.anonymous();
  client.cookies.set("session_id", sid);
  return client;
};

describe("with single sign-on the only way in", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack({ sso: true });
  });
  afterAll(() => stack.stop());
  afterEach(() => {
    stack.upstream.issuer.reset();
    stack.upstream.issuer.setUnreachable(false);
  });
  const issuer = () => stack.upstream.issuer;

  describe("password sign-in", () => {
    test("is announced as off", async () => {
      const result = await stack.anonymous().get("/login");
      expect(result.json).toEqual({
        status: "success",
        body: { app: { version: expect.any(String) }, sso: { enabled: true, localLogin: false } },
        message: "Not logged in.",
      });
    });

    test("is refused with 403 before anything about the request is looked at", async () => {
      const refusal = { status: "failed", message: "Password sign-in is turned off. Sign in with SSO." };
      const headers = { "X-Real-IP": "10.50.0.1" };
      const bodies: unknown[] = [
        { username: "admin", password: ADMIN_PASSWORD },
        { username: "admin", password: "wrong" },
        { username: "admin" },
        {},
        null,
        [],
        "admin",
      ];
      for (const body of bodies) {
        const result = await stack.anonymous().post("/login", body, { headers });
        expect(result.status).toBe(403);
        expect(result.json).toEqual(refusal);
        expect(result.setCookies).toEqual([]);
      }
      const noBody = await stack.anonymous().request("POST", "/login", { headers });
      expect(noBody.status).toBe(403);
      expect(noBody.json).toEqual(refusal);
      // None of them counted as a failed attempt: the address is never shed.
      for (let i = 0; i < 6; i++) {
        expect((await stack.anonymous().post("/login", { username: "admin", password: "wrong" }, { headers })).status).toBe(403);
      }
    });

    test("a session a password started ends at its next request", async () => {
      const client = await seedPasswordSession(stack, "admin");
      const sid = client.cookies.get("session_id") as string;
      const result = await client.get("/login");
      expect(result.json.message).toBe("Not logged in.");
      expect(result.setCookies).toEqual([]);
      expect(await stack.db.rows("sessions", { session_id: sid })).toEqual([]);

      const other = await seedPasswordSession(stack, "demo");
      const refused = await other.get("/api-keys");
      expect(refused.status).toBe(401);
      expect(refused.json).toEqual(NOT_AUTHENTICATED);
      expect(await stack.db.rows("sessions", { session_id: other.cookies.get("session_id") })).toEqual([]);
    });
  });

  describe("the re-check of a single sign-on session", () => {
    test("is not made while it is not due: requests cost the provider nothing", async () => {
      const { client, claims } = await signIn(stack);
      const before = refreshRequests(stack).length;
      const row = await sessionRow(stack, client);
      for (let i = 0; i < 3; i++) expect(await whoAmI(client)).toBe(claims.username);
      expect((await client.get("/api-keys")).status).toBe(200);
      expect(refreshRequests(stack)).toHaveLength(before);
      const after = await sessionRow(stack, client);
      expect((after?.auth_recheck_at as Date).getTime()).toBe((row?.auth_recheck_at as Date).getTime());
      expect(after?.auth_refresh_token).toBe(row?.auth_refresh_token);
      expect(after?.auth_sid).toBe(row?.auth_sid);
    });

    test("when due, refreshes with the provider once and pushes the next one ten minutes out", async () => {
      const { client, claims, refreshToken } = await signIn(stack);
      await makeRecheckDue(stack, client);
      const before = refreshRequests(stack).length;
      const sid = client.cookies.get("session_id");
      const at = Date.now();

      const result = await client.get("/login");
      expect(result.json.status).toBe("success");
      expect((result.body as { user: { username: string } }).user.username).toBe(claims.username);
      expect(result.setCookies).toEqual([`session_id=${sid}; Max-Age=604800; Path=/; HttpOnly; SameSite=Strict`]);

      const requests = refreshRequests(stack).slice(before);
      expect(requests).toHaveLength(1);
      expect(requests[0].method).toBe("POST");
      expect(requests[0].body).toBe(`grant_type=refresh_token&refresh_token=${refreshToken}`);
      expect(requests[0].headers.authorization).toBe(BASIC);
      expect(requests[0].headers["content-type"]).toBe("application/x-www-form-urlencoded");
      expect(requests[0].headers.accept).toBe("application/json");

      const row = await sessionRow(stack, client);
      const recheckAt = (row?.auth_recheck_at as Date).getTime();
      expect(recheckAt).toBeGreaterThanOrEqual(at + 600_000 - 1000);
      expect(recheckAt).toBeLessThanOrEqual(Date.now() + 600_000 + 1000);
      // The provider sent no new refresh token: the old one is kept.
      expect(row?.auth_refresh_token).toBe(refreshToken);
      expect(row?.auth_sid).toBe(claims.sid);
      expect(row?.user_username).toBe(claims.username);

      // Checked, it is served again without asking.
      expect(await whoAmI(client)).toBe(claims.username);
      expect(refreshRequests(stack)).toHaveLength(before + 1);
    });

    test("is made on whichever route the due request is for", async () => {
      const { client } = await signIn(stack);
      await makeRecheckDue(stack, client);
      const before = refreshRequests(stack).length;
      expect((await client.get("/api-keys")).status).toBe(200);
      expect(refreshRequests(stack)).toHaveLength(before + 1);
    });

    test("stores a refresh token the provider rotated, and uses it the next time", async () => {
      const { client, claims } = await signIn(stack);
      await makeRecheckDue(stack, client);
      issuer().state.token = () => jsonResponse(200, { access_token: issuer().accessToken(claims), refresh_token: "rt-rotated-once" });
      expect(await whoAmI(client)).toBe(claims.username);
      expect((await sessionRow(stack, client))?.auth_refresh_token).toBe("rt-rotated-once");

      await makeRecheckDue(stack, client);
      const before = refreshRequests(stack).length;
      issuer().state.token = () => jsonResponse(200, { access_token: issuer().accessToken(claims), refresh_token: 5 });
      expect(await whoAmI(client)).toBe(claims.username);
      expect(refreshRequests(stack).slice(before).map((request) => request.form.get("refresh_token"))).toEqual(["rt-rotated-once"]);
      // A refresh token that is not text is no new refresh token.
      expect((await sessionRow(stack, client))?.auth_refresh_token).toBe("rt-rotated-once");
    });

    test("ends the session when the provider refuses the refresh token", async () => {
      const { client } = await signIn(stack);
      const sid = client.cookies.get("session_id") as string;
      await makeRecheckDue(stack, client);
      issuer().state.token = () => jsonResponse(400, { error: "invalid_grant" });
      const result = await client.get("/login");
      expect(result.status).toBe(200);
      expect(result.json.message).toBe("Not logged in.");
      expect(result.setCookies).toEqual([]);
      expect(await stack.db.rows("sessions", { session_id: sid })).toEqual([]);
      // The provider is not asked about it again.
      const before = refreshRequests(stack).length;
      const refused = await client.get("/api-keys");
      expect(refused.status).toBe(401);
      expect(refused.json).toEqual(NOT_AUTHENTICATED);
      expect(refreshRequests(stack)).toHaveLength(before);
    });

    test("ends the session on a protected route with a 401", async () => {
      const { client } = await signIn(stack);
      await makeRecheckDue(stack, client);
      issuer().state.token = () => jsonResponse(400, { error: "invalid_grant" });
      const refused = await client.get("/api-keys");
      expect(refused.status).toBe(401);
      expect(refused.json).toEqual(NOT_AUTHENTICATED);
      expect(refused.setCookies).toEqual([]);
    });

    test("ends the session when the refreshed token carries no role", async () => {
      const { client, claims } = await signIn(stack);
      const sid = client.cookies.get("session_id") as string;
      await makeRecheckDue(stack, client);
      issuer().state.token = () => jsonResponse(200, { access_token: issuer().accessToken({ ...claims, role: "" }) });
      expect(await whoAmI(client)).toBeUndefined();
      expect(await stack.db.rows("sessions", { session_id: sid })).toEqual([]);
    });

    test("ends a session that has no refresh token at its first re-check, without asking the provider", async () => {
      const { client, claims } = await signIn(stack, { refreshToken: null });
      expect(await whoAmI(client)).toBe(claims.username);
      const sid = client.cookies.get("session_id") as string;
      await makeRecheckDue(stack, client);
      const before = refreshRequests(stack).length;
      expect(await whoAmI(client)).toBeUndefined();
      expect(refreshRequests(stack)).toHaveLength(before);
      expect(await stack.db.rows("sessions", { session_id: sid })).toEqual([]);
    });

    describe("while the provider cannot answer", () => {
      const outages: [string, () => void, string][] = [
        ["is failing on its side", () => (issuer().state.down = true), "Single sign-on re-check could not reach the identity provider"],
        ["is rate limiting", () => (issuer().state.token = () => jsonResponse(429, { error: "slow_down" })), "Single sign-on re-check could not reach the identity provider"],
        ["answers with no access token", () => (issuer().state.token = () => jsonResponse(200, { token_type: "Bearer" })), "Single sign-on re-check could not reach the identity provider"],
        ["answers with something that is not JSON", () => (issuer().state.token = () => new Response("oops", { status: 200 })), "Single sign-on re-check could not reach the identity provider"],
        ["refuses the client", () => (issuer().state.token = () => jsonResponse(401, { error: "invalid_client" })), "Single sign-on re-check failed"],
        ["answers with a token that does not verify", () => (issuer().state.token = () => jsonResponse(200, { access_token: issuer().accessToken({ aud: "another-app" }) })), "Single sign-on re-check failed"],
        ["answers with an expired token", () => (issuer().state.token = () => jsonResponse(200, { access_token: issuer().accessToken({ iat: nowS() - 900, exp: nowS() - 120 }) })), "Single sign-on re-check failed"],
      ];
      for (const [what, breakIt, logged] of outages) {
        test(`(it ${what}) the session is served as it was, and every request asks again`, async () => {
          const { client, claims, refreshToken } = await signIn(stack);
          await makeRecheckDue(stack, client, 30);
          const row = await sessionRow(stack, client);
          const before = refreshRequests(stack).length;
          const logs = stack.logCount(logged);
          breakIt();

          expect(await whoAmI(client)).toBe(claims.username);
          expect((await client.get("/api-keys")).status).toBe(200);
          expect(refreshRequests(stack)).toHaveLength(before + 2);
          await stack.waitForLog(logged, { count: logs + 2 });
          const during = await sessionRow(stack, client);
          expect((during?.auth_recheck_at as Date).getTime()).toBe((row?.auth_recheck_at as Date).getTime());
          expect(during?.auth_refresh_token).toBe(refreshToken);

          // The provider answers again: the re-check goes through and the session is good for ten more minutes.
          issuer().reset();
          expect(await whoAmI(client)).toBe(claims.username);
          expect(refreshRequests(stack)).toHaveLength(before + 3);
          expect(((await sessionRow(stack, client))?.auth_recheck_at as Date).getTime()).toBeGreaterThan(Date.now() + 500_000);
        });
      }

      test("(it is unreachable) the session is served as it was", async () => {
        const { client, claims } = await signIn(stack);
        await makeRecheckDue(stack, client, 30);
        issuer().setUnreachable(true);
        try {
          expect(await whoAmI(client)).toBe(claims.username);
          expect(await whoAmI(client)).toBe(claims.username);
        } finally {
          issuer().setUnreachable(false);
        }
        expect(((await sessionRow(stack, client))?.auth_recheck_at as Date).getTime()).toBeLessThan(Date.now());
      });

      test("a session is served for an hour past its re-check, and no longer", async () => {
        const within = await signIn(stack);
        const past = await signIn(stack);
        const pastOther = await signIn(stack);
        await makeRecheckDue(stack, within.client, 59 * 60);
        await makeRecheckDue(stack, past.client, 61 * 60);
        await makeRecheckDue(stack, pastOther.client, 24 * 3600);
        const [pastSid, pastOtherSid] = [past.client.cookies.get("session_id"), pastOther.client.cookies.get("session_id")];

        issuer().state.down = true;
        expect(await whoAmI(within.client)).toBe(within.claims.username);
        expect(await whoAmI(past.client)).toBeUndefined();
        expect(await stack.db.rows("sessions", { session_id: pastSid })).toEqual([]);
        // The same for a failure that is not an outage.
        issuer().state.down = false;
        issuer().state.token = () => jsonResponse(401, { error: "invalid_client" });
        expect(await whoAmI(within.client)).toBe(within.claims.username);
        const refused = await pastOther.client.get("/api-keys");
        expect(refused.status).toBe(401);
        expect(await stack.db.rows("sessions", { session_id: pastOtherSid })).toEqual([]);
        expect(await sessionRow(stack, within.client)).toBeDefined();
      });
    });

    test("is shared by requests of the session that arrive together", async () => {
      const { client, claims } = await signIn(stack);
      await makeRecheckDue(stack, client);
      const before = refreshRequests(stack).length;
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      issuer().state.token = async () => {
        await held;
        return jsonResponse(200, { access_token: issuer().accessToken(claims) });
      };
      const first = client.get<{ user?: { username: string } }>("/login");
      await stack.waitFor(() => refreshRequests(stack).length > before, { what: "the refresh to reach the provider" });
      // These arrive while the first one's refresh is still out. Nothing shows from outside that they
      // have, so they are given a moment; the count below holds either way, since a request that
      // arrives after the refresh finds the session no longer due.
      const rest = [client.get<{ user?: { username: string } }>("/login"), client.get<{ user?: { username: string } }>("/login"), client.get("/api-keys")];
      await new Promise((resolve) => setTimeout(resolve, 150));
      release();
      const results = await Promise.all([first, ...rest]);
      expect(results.map((result) => result.status)).toEqual([200, 200, 200, 200]);
      expect((await first).body.user?.username).toBe(claims.username);
      expect(refreshRequests(stack)).toHaveLength(before + 1);
    });

    test("does not serve a session that was ended while the provider was being asked", async () => {
      const { client, claims } = await signIn(stack);
      const sid = client.cookies.get("session_id") as string;
      await makeRecheckDue(stack, client);
      const before = refreshRequests(stack).length;
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      issuer().state.token = async () => {
        await held;
        return jsonResponse(200, { access_token: issuer().accessToken(claims) });
      };
      const pending = client.get("/login");
      await stack.waitFor(() => refreshRequests(stack).length > before, { what: "the refresh to reach the provider" });
      await stack.db.query("DELETE FROM sessions WHERE session_id = $1", [sid]);
      release();
      const result = await pending;
      expect(result.json.message).toBe("Not logged in.");
      expect(result.setCookies).toEqual([]);
      expect(await stack.db.rows("sessions", { session_id: sid })).toEqual([]);
    });
  });

  describe("DELETE /login", () => {
    const logoutUrl = `${ISSUER}/logout?client_id=${CLIENT_ID}&post_logout_redirect_uri=${encodeURIComponent("https://budget.example.test/")}`;
    const revocations = () => issuer().seen("/oauth/revoke");

    test("ends the session, revokes its refresh token at the provider, and says where to sign out there", async () => {
      const { client, refreshToken } = await signIn(stack);
      const sid = client.cookies.get("session_id") as string;
      const before = revocations().length;
      const result = await client.delete("/login");
      expect(result.status).toBe(200);
      expect(result.json).toEqual({ status: "success", body: { logoutUrl } });
      expect(result.setCookies).toEqual([SESSION_CLEARED]);
      await stack.waitFor(async () => (await stack.db.rows("sessions", { session_id: sid })).length === 0, { what: "the session to be deleted" });

      await stack.waitFor(() => revocations().length > before, { what: "the revocation" });
      const [request] = revocations().slice(before);
      expect(request.method).toBe("POST");
      expect(request.body).toBe(`token=${refreshToken}&token_type_hint=refresh_token`);
      expect(request.headers.authorization).toBe(BASIC);
      expect(request.headers["content-type"]).toBe("application/x-www-form-urlencoded");

      const replay = await stack.anonymous().get("/login", { headers: { Cookie: `session_id=${sid}` } });
      expect(replay.json.message).toBe("Not logged in.");
    });

    test("revokes nothing for a session that has no refresh token, and for nobody at all", async () => {
      const before = revocations().length;
      const without = await signIn(stack, { refreshToken: null });
      const first = await without.client.delete("/login");
      expect(first.json).toEqual({ status: "success", body: { logoutUrl } });

      // Nobody signed in: no provider session to end, so no URL either.
      const anonymous = await stack.anonymous().delete("/login");
      expect(anonymous.status).toBe(200);
      expect(anonymous.json).toEqual({ status: "success" });
      expect(anonymous.setCookies).toEqual([SESSION_CLEARED]);

      // A sign-out that does revoke, to show the two before it did not.
      const withToken = await signIn(stack);
      await withToken.client.delete("/login");
      await stack.waitFor(() => revocations().length > before, { what: "the revocation" });
      expect(revocations().slice(before).map((request) => request.form.get("token"))).toEqual([withToken.refreshToken]);
    });

    test("signs out here even when the provider will not revoke", async () => {
      const refusals: (() => Response)[] = [
        () => jsonResponse(400, { error: "unsupported_token_type" }),
        () => jsonResponse(503, {}),
        () => new Response(null, { status: 302, headers: { Location: "/elsewhere" } }),
      ];
      for (const refusal of refusals) {
        const { client } = await signIn(stack);
        const logs = stack.logCount("Failed to revoke the single sign-on refresh token");
        issuer().state.revoke = refusal;
        const result = await client.delete("/login");
        expect(result.json).toEqual({ status: "success", body: { logoutUrl } });
        expect(result.setCookies).toEqual([SESSION_CLEARED]);
        await stack.waitForLog("Failed to revoke the single sign-on refresh token", { count: logs + 1 });
        expect(await whoAmI(client)).toBeUndefined();
      }
    });

    test("signs out here when the provider cannot be reached", async () => {
      const { client } = await signIn(stack);
      const logs = stack.logCount("Failed to revoke the single sign-on refresh token");
      issuer().setUnreachable(true);
      try {
        const result = await client.delete("/login");
        // The provider's addresses were read when signing in, so the URL is still known.
        expect(result.json).toEqual({ status: "success", body: { logoutUrl } });
        await stack.waitForLog("Failed to revoke the single sign-on refresh token", { count: logs + 1 });
      } finally {
        issuer().setUnreachable(false);
      }
    });

    test("signs out a session whose re-check is due and refused, as nobody", async () => {
      const { client } = await signIn(stack);
      await makeRecheckDue(stack, client);
      issuer().state.token = () => jsonResponse(400, { error: "invalid_grant" });
      const before = revocations().length;
      const result = await client.delete("/login");
      // The session ended while the request was read, so there is nothing of single sign-on left to sign out of.
      expect(result.json).toEqual({ status: "success" });
      expect(result.setCookies).toEqual([SESSION_CLEARED]);
      // A sign-out that does revoke, to show this one did not.
      const next = await signIn(stack);
      await next.client.delete("/login");
      await stack.waitFor(() => revocations().length > before, { what: "the revocation" });
      expect(revocations().slice(before).map((request) => request.form.get("token"))).toEqual([next.refreshToken]);
    });
  });

  describe("after a restart, before anything was read from the provider", () => {
    const restartWith = async (prepare: () => void): Promise<void> => {
      issuer().reset();
      prepare();
      await stack.restart({}, { skipSyncWait: true });
    };

    test("a session is still there, and still not due", async () => {
      const { client, claims } = await signIn(stack);
      const before = refreshRequests(stack).length;
      await restartWith(() => undefined);
      expect(await whoAmI(client)).toBe(claims.username);
      expect(refreshRequests(stack)).toHaveLength(before);
    });

    test("signing out with the provider unreachable signs out here, with no URL to give", async () => {
      const { client } = await signIn(stack);
      await restartWith(() => issuer().setUnreachable(true));
      try {
        const logs = stack.logCount("Failed to build the single sign-on logout URL");
        const result = await client.delete("/login");
        expect(result.status).toBe(200);
        expect(result.json).toEqual({ status: "success" });
        expect(result.setCookies).toEqual([SESSION_CLEARED]);
        await stack.waitForLog("Failed to build the single sign-on logout URL", { count: logs + 1 });
        await stack.waitForLog("Failed to revoke the single sign-on refresh token");
        expect(await whoAmI(client)).toBeUndefined();
      } finally {
        issuer().setUnreachable(false);
      }
    });

    test("a provider with no end-session or revocation endpoint: signing out here is all there is", async () => {
      const { client } = await signIn(stack);
      await restartWith(() => {
        delete issuer().state.discovery.end_session_endpoint;
        delete issuer().state.discovery.revocation_endpoint;
      });
      const [urlLogs, revokeLogs] = [
        stack.logCount("Failed to build the single sign-on logout URL"),
        stack.logCount("Failed to revoke the single sign-on refresh token"),
      ];
      const before = issuer().seen("/oauth/revoke").length;
      const result = await client.delete("/login");
      expect(result.json).toEqual({ status: "success" });
      await stack.waitForLog("Failed to build the single sign-on logout URL", { count: urlLogs + 1 });
      await stack.waitForLog("Failed to revoke the single sign-on refresh token", { count: revokeLogs + 1 });
      expect(issuer().seen("/oauth/revoke")).toHaveLength(before);
    });

    test("an end-session endpoint with a query of its own keeps it", async () => {
      const { client } = await signIn(stack);
      await restartWith(() => {
        issuer().state.discovery.end_session_endpoint = `${ISSUER}/logout?tenant=a%20b&client_id=old#top`;
      });
      const before = issuer().seen("/oauth/revoke").length;
      const result = await client.delete("/login");
      expect(result.json).toEqual({
        status: "success",
        body: { logoutUrl: `${ISSUER}/logout?tenant=a+b&client_id=${CLIENT_ID}&post_logout_redirect_uri=${encodeURIComponent("https://budget.example.test/")}#top` },
      });
      await stack.waitFor(() => issuer().seen("/oauth/revoke").length > before, { what: "the revocation" });
    });

    test("a re-check with the provider unreachable serves the session; one refused ends it", async () => {
      const served = await signIn(stack);
      const ended = await signIn(stack);
      await makeRecheckDue(stack, served.client, 30);
      await makeRecheckDue(stack, ended.client, 2 * 3600);
      await restartWith(() => issuer().setUnreachable(true));
      try {
        expect(await whoAmI(served.client)).toBe(served.claims.username);
        expect(await whoAmI(ended.client)).toBeUndefined();
      } finally {
        issuer().setUnreachable(false);
      }
      // Reachable again: discovery, the refresh and the keys are all read for the first time.
      expect(await whoAmI(served.client)).toBe(served.claims.username);
      expect(((await sessionRow(stack, served.client))?.auth_recheck_at as Date).getTime()).toBeGreaterThan(Date.now());
    });
  });
});

describe("with password sign-in kept next to single sign-on (AUTH_LOCAL_LOGIN)", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack({ sso: { AUTH_LOCAL_LOGIN: "true" } });
  });
  afterAll(() => stack.stop());
  afterEach(() => stack.upstream.issuer.reset());

  const passwordLogin = (username: string, password: string, ip: string): Promise<ApiResult> =>
    stack.anonymous().post("/login", { username, password }, { headers: { "X-Real-IP": ip } });

  test("both ways in are announced", async () => {
    const result = await stack.anonymous().get("/login");
    expect(result.json).toEqual({
      status: "success",
      body: { app: { version: expect.any(String) }, sso: { enabled: true, localLogin: true } },
      message: "Not logged in.",
    });
  });

  test("a password signs in an account that is not linked, and the session is an ordinary one", async () => {
    const client = await stack.login();
    const row = await sessionRow(stack, client);
    expect(row).toMatchObject({ user_username: "admin", auth_sid: null, auth_refresh_token: null, auth_recheck_at: null });
    const before = refreshRequests(stack).length;
    for (let i = 0; i < 3; i++) expect(await whoAmI(client)).toBe("admin");
    // Never re-checked: the provider knows nothing of it.
    expect(refreshRequests(stack)).toHaveLength(before);
    expect(await sessionRow(stack, client)).toMatchObject({ auth_sid: null, auth_refresh_token: null, auth_recheck_at: null });

    const out = await client.delete("/login");
    expect(out.json).toEqual({ status: "success" });
    expect(out.setCookies).toEqual([SESSION_CLEARED]);
  });

  test("signing out a password session calls nothing at the provider", async () => {
    const before = stack.upstream.issuer.seen("/oauth/revoke").length;
    const client = await stack.login("demo");
    expect((await client.delete("/login")).json).toEqual({ status: "success" });
    const sso = await signIn(stack);
    await sso.client.delete("/login");
    await stack.waitFor(() => stack.upstream.issuer.seen("/oauth/revoke").length > before, { what: "the revocation" });
    expect(stack.upstream.issuer.seen("/oauth/revoke").slice(before).map((request) => request.form.get("token"))).toEqual([sso.refreshToken]);
  });

  test("a password does not sign in an account linked to the provider", async () => {
    const linked = await createUser(stack, "linked-with-password", { auth_sub: "usr_linked_with_password" });
    const refused = await passwordLogin(linked.username, linked.password, "10.51.0.1");
    expect(refused.status).toBe(200);
    expect(refused.json).toEqual({ status: "failed", message: "Invalid username or password." });
    expect(refused.setCookies).toEqual([]);

    // The link is what refuses it: without it the same password signs in.
    await stack.db.query("UPDATE users SET auth_sub = NULL WHERE user_id = $1", [linked.user_id]);
    const accepted = await passwordLogin(linked.username, linked.password, "10.51.0.1");
    expect(accepted.json).toEqual({ status: "success", body: { user_id: linked.user_id, username: linked.username } });
  });

  test("an account stops taking its password the moment single sign-on links it", async () => {
    const local = await createUser(stack, "about-to-link", { email: "about-to-link@example.test" });
    const password = await stack.anonymous().login(local.username, local.password);
    const client = stack.anonymous();
    await ssoSignIn(stack, client, {
      claims: { sub: "usr_about_to_link", username: "about-to-link-idp", sid: "ses_about_to_link" },
      idClaims: { email: "ABOUT-TO-LINK@example.test" },
    });
    expect(await whoAmI(client)).toBe(local.username);
    expect((await passwordLogin(local.username, local.password, "10.51.0.2")).json).toEqual({
      status: "failed",
      message: "Invalid username or password.",
    });
    // The session the password started before is not ended by the link.
    expect(await whoAmI(password)).toBe(local.username);
  });

  test("an account single sign-on created has no password to sign in with", async () => {
    const { claims } = await signIn(stack);
    for (const password of ["", "password", claims.sub]) {
      expect((await passwordLogin(claims.username, password, "10.51.0.3")).json).toEqual({
        status: "failed",
        message: "Invalid username or password.",
      });
    }
  });

  test("a refused linked account counts as a failed attempt", async () => {
    const linked = await createUser(stack, "linked-and-counted", { auth_sub: "usr_linked_and_counted" });
    for (let i = 0; i < 5; i++) {
      expect((await passwordLogin(linked.username, linked.password, "10.51.0.4")).status).toBe(200);
    }
    const shed = await passwordLogin(linked.username, linked.password, "10.51.0.4");
    expect(shed.status).toBe(429);
    expect(shed.json).toEqual({ status: "failed", message: "Too many login attempts, try again later" });
  });

  test("a single sign-on session is re-checked all the same", async () => {
    const { client, claims } = await signIn(stack);
    await makeRecheckDue(stack, client);
    const before = refreshRequests(stack).length;
    expect(await whoAmI(client)).toBe(claims.username);
    expect(refreshRequests(stack)).toHaveLength(before + 1);
    await makeRecheckDue(stack, client);
    stack.upstream.issuer.state.token = () => jsonResponse(400, { error: "invalid_grant" });
    expect(await whoAmI(client)).toBeUndefined();
  });
});
