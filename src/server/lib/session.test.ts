import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";
import { accessToken, json, startFakeIssuer } from "test-issuer";
import type { SessionAuth, SessionData } from "./postgres/models/session";

const { driver, mockUnsafe, resetSqlMocks } = createFakeSql();
mock.module("./postgres/sql-driver", () => driver);

const {
  SSO_MAX_STALENESS_MS,
  SSO_RECHECK_INTERVAL_MS,
  buildSessionCookie,
  buildSessionData,
  loadSessionData,
  parseCookies,
  recheckSession,
  saveSession,
  watchSession,
} = await import("./session");
const { configureSso } = await import("./sso");

const issuer = startFakeIssuer();

afterAll(() => {
  configureSso(null);
  issuer.stop();
  restoreLeaves();
});

beforeEach(() => {
  resetSqlMocks();
  issuer.reset();
  configureSso(issuer.config(), { fetch: issuer.fetch });
});

const USER = { user_id: "u-1", username: "alice" };
const MINUTE = 60 * 1000;

const ssoSession = (auth: Partial<SessionAuth> = {}): SessionData =>
  buildSessionData(USER, false, {
    sid: "ses_1",
    refreshToken: "rt_1",
    recheckAt: new Date(Date.now() - MINUTE),
    ...auth,
  });

const statements = () => mockUnsafe.mock.calls.map(([sql]) => String(sql));

/** Answers the store's row read with `row`, and every write as one row touched. */
const scriptRows = (row: Record<string, unknown> | null) => {
  mockUnsafe.mockImplementation(async (sql: string) => {
    if (sql.startsWith("SELECT")) return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    return { rows: [{ session_id: "s-1" }], rowCount: 1 };
  });
};

const sessionRow = (overrides: Record<string, unknown> = {}) => ({
  session_id: "s-1",
  user_user_id: "u-1",
  user_username: "alice",
  cookie_original_max_age: null,
  cookie_max_age: null,
  cookie_signed: null,
  cookie_expires: new Date(Date.now() + 3600_000).toISOString(),
  cookie_http_only: null,
  cookie_path: null,
  cookie_domain: null,
  cookie_secure: null,
  cookie_same_site: null,
  created_at: null,
  updated: null,
  auth_sid: null,
  auth_refresh_token: null,
  auth_recheck_at: null,
  ...overrides,
});

describe("session cookie", () => {
  test("is the app's own session_id cookie, Secure only when asked", () => {
    expect(buildSessionCookie("abc", 60, false)).toBe(
      "session_id=abc; Max-Age=60; Path=/; HttpOnly; SameSite=Strict",
    );
    expect(buildSessionCookie("abc", 60, true)).toEndWith("; Secure");
  });

  test("reads back from a Cookie header among others", () => {
    expect(parseCookies("a=1; session_id=abc%3D; __Host-login=x")).toEqual({
      a: "1",
      session_id: "abc=",
      "__Host-login": "x",
    });
  });

  test("drops a cookie with a malformed percent sequence instead of throwing", () => {
    expect(parseCookies("session_id=%E0%A4%A")).toEqual({});
  });

  test("keeps the well-formed cookies alongside a malformed one", () => {
    expect(parseCookies("bad=%E0%A4%A; session_id=abc%20def; other=%")).toEqual({
      session_id: "abc def",
    });
  });

  test("skips parts without a name or without an equals sign", () => {
    expect(parseCookies("=orphan; flag; session_id=x")).toEqual({ session_id: "x" });
  });

  test("an empty header yields no cookies", () => {
    expect(parseCookies("")).toEqual({});
  });
});

describe("saveSession", () => {
  const verb = () => statements().map((sql) => sql.split(" ")[0]);

  test("a session that was just started is inserted", async () => {
    await saveSession("s-1", USER, false, false);
    expect(verb()).toEqual(["INSERT"]);
  });

  test("with single sign-on off, an existing session is upserted, as before", async () => {
    configureSso(null);
    await saveSession("s-1", USER, false, true);
    expect(statements()[0]).toStartWith("INSERT INTO sessions");
    expect(statements()[0]).toContain("ON CONFLICT (session_id) DO UPDATE SET");
  });

  test("with single sign-on on, an existing session is only updated, so a deleted one stays deleted", async () => {
    await saveSession("s-1", USER, false, true);
    expect(verb()).toEqual(["UPDATE"]);
    expect(statements()[0]).not.toContain("auth_");
  });
});

describe("recheckSession", () => {
  test("a password session is served as read, with no query and no call to the provider", async () => {
    configureSso({ ...issuer.config(), localLogin: true }, { fetch: issuer.fetch });
    const data = buildSessionData(USER, false);
    expect(await recheckSession("s-1", data)).toBe(data);
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(issuer.state.seen).toEqual([]);
  });

  test("with single sign-on off, a password session is served as read, as before", async () => {
    configureSso(null);
    const data = buildSessionData(USER, false);
    expect(await recheckSession("s-1", data)).toBe(data);
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("a password session ends while single sign-on is the only way in", async () => {
    scriptRows(null);
    expect(await recheckSession("s-1", buildSessionData(USER, false))).toBeNull();
    expect(statements()).toEqual(["DELETE FROM sessions WHERE session_id = $1 RETURNING session_id"]);
    expect(issuer.state.seen).toEqual([]);
  });

  test("a single sign-on session whose re-check is not due costs nothing", async () => {
    const data = ssoSession({ recheckAt: new Date(Date.now() + MINUTE) });
    expect(await recheckSession("s-1", data)).toBe(data);
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(issuer.state.seen).toEqual([]);
  });

  test("a due re-check refreshes, keeps the refresh token, and stores the next re-check", async () => {
    scriptRows(null);
    const before = Date.now();
    const result = await recheckSession("s-1", ssoSession());

    const [refresh] = issuer.seen("/oauth/token");
    expect(refresh.form.get("grant_type")).toBe("refresh_token");
    expect(refresh.form.get("refresh_token")).toBe("rt_1");
    expect(result?.auth?.refreshToken).toBe("rt_1");
    const next = result!.auth!.recheckAt.getTime();
    expect(next).toBeGreaterThanOrEqual(before + SSO_RECHECK_INTERVAL_MS);
    expect(next).toBeLessThanOrEqual(Date.now() + SSO_RECHECK_INTERVAL_MS);

    const [[sql, values]] = mockUnsafe.mock.calls as unknown as [string, unknown[]][];
    expect(sql).toBe(
      "UPDATE sessions SET updated = CURRENT_TIMESTAMP, auth_sid = $1, auth_refresh_token = $2, auth_recheck_at = $3 WHERE session_id = $4 RETURNING session_id",
    );
    expect(values.slice(0, 4)).toEqual(["ses_1", "rt_1", new Date(next).toISOString(), "s-1"]);
  });

  test("a rotated refresh token replaces the old one", async () => {
    scriptRows(null);
    issuer.state.token = () => json(200, { access_token: accessToken(), refresh_token: "rt_2" });
    const result = await recheckSession("s-1", ssoSession());
    expect(result?.auth?.refreshToken).toBe("rt_2");
    expect((mockUnsafe.mock.calls[0][1] as unknown[])[1]).toBe("rt_2");
  });

  test("a session deleted while it was re-checked is not served", async () => {
    mockUnsafe.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    expect(await recheckSession("s-1", ssoSession())).toBeNull();
  });

  test("a refused refresh token ends the session", async () => {
    scriptRows(null);
    issuer.state.token = () => json(400, { error: "invalid_grant" });
    expect(await recheckSession("s-1", ssoSession())).toBeNull();
    expect(statements()).toEqual(["DELETE FROM sessions WHERE session_id = $1 RETURNING session_id"]);
  });

  test("a session without a refresh token ends at its first re-check", async () => {
    scriptRows(null);
    expect(await recheckSession("s-1", ssoSession({ refreshToken: null }))).toBeNull();
    expect(statements()).toEqual(["DELETE FROM sessions WHERE session_id = $1 RETURNING session_id"]);
    expect(issuer.state.seen).toEqual([]);
  });

  test("an unreachable provider still serves the session, unchanged, and the next request tries again", async () => {
    issuer.state.down = true;
    const data = ssoSession({ recheckAt: new Date(Date.now() - SSO_MAX_STALENESS_MS + MINUTE) });
    expect(await recheckSession("s-1", data)).toBe(data);
    expect(mockUnsafe).not.toHaveBeenCalled();

    issuer.state.down = false;
    scriptRows(null);
    expect((await recheckSession("s-1", data))?.auth?.recheckAt.getTime()).toBeGreaterThan(Date.now());
  });

  test("an hour past its re-check, an unreachable provider ends the session", async () => {
    scriptRows(null);
    issuer.state.down = true;
    const data = ssoSession({ recheckAt: new Date(Date.now() - SSO_MAX_STALENESS_MS - MINUTE) });
    expect(await recheckSession("s-1", data)).toBeNull();
    expect(statements()).toEqual(["DELETE FROM sessions WHERE session_id = $1 RETURNING session_id"]);
  });

  test("any other failure is treated like an unreachable provider", async () => {
    scriptRows(null);
    issuer.state.token = () => json(401, { error: "invalid_client" });
    const fresh = ssoSession();
    expect(await recheckSession("s-1", fresh)).toBe(fresh);
    const stale = ssoSession({ recheckAt: new Date(Date.now() - SSO_MAX_STALENESS_MS - MINUTE) });
    expect(await recheckSession("s-1", stale)).toBeNull();
  });

  test("a token without a role ends the session", async () => {
    scriptRows(null);
    issuer.state.token = () => json(200, { access_token: accessToken({ role: "" }) });
    expect(await recheckSession("s-1", ssoSession())).toBeNull();
  });

  test("concurrent requests of one session share a single refresh", async () => {
    scriptRows(null);
    const data = ssoSession();
    const results = await Promise.all([1, 2, 3].map(() => recheckSession("s-1", data)));
    expect(issuer.seen("/oauth/token")).toHaveLength(1);
    expect(results.map((r) => r?.auth?.refreshToken)).toEqual(["rt_1", "rt_1", "rt_1"]);
  });

  test("once single sign-on is off, a session it started ends", async () => {
    configureSso(null);
    scriptRows(null);
    expect(
      await recheckSession("s-1", ssoSession({ recheckAt: new Date(Date.now() + MINUTE) })),
    ).toBeNull();
    expect(statements()).toEqual(["DELETE FROM sessions WHERE session_id = $1 RETURNING session_id"]);
  });
});

describe("loadSessionData", () => {
  test("reads the row with its single sign-on fields", async () => {
    const recheckAt = new Date(Date.now() + MINUTE).toISOString();
    scriptRows(
      sessionRow({ auth_sid: "ses_1", auth_refresh_token: "rt_1", auth_recheck_at: recheckAt }),
    );
    const data = await loadSessionData("s-1");
    expect(data?.user).toEqual(USER);
    expect(data?.auth).toEqual({ sid: "ses_1", refreshToken: "rt_1", recheckAt: new Date(recheckAt) });
  });

  test("a password session has no single sign-on fields", async () => {
    scriptRows(sessionRow());
    expect((await loadSessionData("s-1"))?.auth).toBeUndefined();
  });

  test("a missing row is no session", async () => {
    scriptRows(null);
    expect(await loadSessionData("s-1")).toBeNull();
  });
});

describe("watchSession", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

  test("reports a session that is gone, once, and stops reading", async () => {
    scriptRows(null);
    let ended = 0;
    watchSession("s-1", () => ended++, 5);
    await settle();
    expect(ended).toBe(1);
    expect(statements()).toHaveLength(1);
  });

  test("stays quiet while the session is there, until stopped", async () => {
    configureSso({ ...issuer.config(), localLogin: true }, { fetch: issuer.fetch });
    scriptRows(sessionRow());
    let ended = 0;
    const stop = watchSession("s-1", () => ended++, 5);
    await settle();
    stop();
    const reads = statements().length;
    expect(reads).toBeGreaterThan(1);
    await settle();
    expect(statements()).toHaveLength(reads);
    expect(ended).toBe(0);
  });

  test("a failed read leaves the connection open", async () => {
    mockUnsafe.mockImplementation(async () => {
      throw new Error("connection refused");
    });
    let ended = 0;
    const stop = watchSession("s-1", () => ended++, 5);
    await settle();
    stop();
    expect(ended).toBe(0);
  });
});
