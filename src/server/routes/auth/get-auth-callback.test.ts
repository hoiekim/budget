import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";
import {
  TEST_REDIRECT_URI,
  accessToken,
  idToken,
  json,
  startFakeIssuer,
} from "test-issuer";

/** Usernames held by unlinked local accounts. */
let localAccounts = new Set<string>();
/** The unlinked local account that has an email, by that email in lower case. */
let emailAccounts = new Map<string, { user_id: string; username: string }>();

const { driver, mockUnsafe, resetSqlMocks } = createFakeSql(async (sql: string, values?: unknown[]) => {
  if (sql.startsWith("SELECT * FROM users WHERE lower(email) = lower($1)")) {
    const account = emailAccounts.get(String(values?.[0]).toLowerCase());
    if (!account) return { rows: [], rowCount: 0 };
    const row = {
      ...account,
      password: "$2b$10$hash",
      email: values?.[0],
      expiry: null,
      token: null,
      auth_sub: null,
      updated: null,
      is_deleted: false,
    };
    return { rows: [row], rowCount: 1 };
  }
  if (sql.startsWith("UPDATE users SET")) {
    return { rows: [{ user_id: values?.[1] }], rowCount: 1 };
  }
  if (sql.startsWith("INSERT INTO users")) {
    const [username] = values as string[];
    if (localAccounts.has(username)) return { rows: [], rowCount: 0 };
    return { rows: [{ user_id: "u-new", username }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
});
mock.module("../../lib/postgres/sql-driver", () => driver);

const { getAuthCallbackRoute } = await import("./get-auth-callback");
const { configureSso, getSso } = await import("server/lib/sso");

const issuer = startFakeIssuer();

afterAll(() => {
  configureSso(null);
  issuer.stop();
  restoreLeaves();
});

beforeEach(() => {
  resetSqlMocks();
  issuer.reset();
  localAccounts = new Set(["admin", "demo"]);
  emailAccounts = new Map();
  configureSso(issuer.config(), { fetch: issuer.fetch });
});

/**
 * Starts a sign-in the way the login route does, and has the provider's
 * token endpoint answer for it. Returns the login cookie and the state the
 * provider would send back.
 */
const begin = async (claims: object = {}, returnTo = "/budgets", idClaims: object = {}) => {
  const { redirectUrl, loginCookie } = await getSso()!.client.startLogin(
    new Request("https://budget.example.test/api/auth/login"),
    { returnTo },
  );
  const authorize = new URL(redirectUrl);
  const nonce = authorize.searchParams.get("nonce");
  issuer.state.token = () =>
    json(200, {
      access_token: accessToken(claims),
      id_token: idToken({ nonce, ...idClaims }),
      refresh_token: "rt_1",
      token_type: "Bearer",
    });
  return { cookie: loginCookie.split(";")[0], state: authorize.searchParams.get("state")! };
};

interface SessionStub {
  id: string;
  user?: { user_id: string; username: string };
  regenerated: number;
}

const makeReq = (query: Record<string, string>, cookie?: string, session?: SessionStub) => {
  const url = new URL(TEST_REDIRECT_URI);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  const stub: SessionStub = session ?? { id: "s-old", regenerated: 0 };
  return {
    method: "GET",
    path: "/auth/callback",
    url: url.toString(),
    headers: cookie ? { cookie } : {},
    query,
    body: undefined,
    session: Object.assign(stub, {
      async regenerate() {
        stub.regenerated += 1;
        stub.id = "s-new";
        stub.user = undefined;
      },
      async destroy() {},
    }),
    ip: "127.0.0.1",
  } as unknown as Parameters<typeof getAuthCallbackRoute.execute>[0];
};

const fakeRes = () => {
  const res = {
    statusCode: 200,
    headersSent: false,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    write() {
      return true;
    },
    end() {},
  };
  return res as unknown as Parameters<typeof getAuthCallbackRoute.execute>[1] & { statusCode: number };
};

const callback = async (query: Record<string, string>, cookie?: string, session?: SessionStub) =>
  (await getAuthCallbackRoute.execute(makeReq(query, cookie, session), fakeRes())) as Response;

const sessionWrites = () =>
  mockUnsafe.mock.calls.filter(([sql]) => String(sql).startsWith("INSERT INTO sessions"));

const clearsLoginCookie = (response: Response) =>
  response.headers
    .getSetCookie()
    .some((cookie) => cookie.startsWith("__Host-login=;") && cookie.includes("Max-Age=0"));

describe("GET /api/auth/callback", () => {
  test("a new person gets a user and a session, and lands where they were going", async () => {
    const { cookie, state } = await begin({}, "/accounts");
    const session: SessionStub = { id: "s-old", user: { user_id: "u-x", username: "x" }, regenerated: 0 };
    const response = await callback({ code: "c1", state }, cookie, session);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/accounts");
    expect(issuer.seen("/oauth/token")[0].form.get("code")).toBe("c1");

    const cookies = response.headers.getSetCookie();
    expect(clearsLoginCookie(response)).toBe(true);
    expect(cookies).toContain("session_id=s-new; Max-Age=604800; Path=/; HttpOnly; SameSite=Strict");
    expect(session.regenerated).toBe(1);

    const [[sql, values]] = sessionWrites() as unknown as [string, unknown[]][];
    const columns = sql.match(/\(([^)]*)\)/)![1].split(", ").slice(1);
    const row = Object.fromEntries(columns.map((column, i) => [column, values[i]]));
    expect(row).toMatchObject({
      session_id: "s-new",
      user_user_id: "u-new",
      user_username: "alice",
      auth_sid: "ses_1",
      auth_refresh_token: "rt_1",
    });
    expect(new Date(row.auth_recheck_at as string).getTime()).toBeGreaterThan(Date.now());
  });

  test("a new person's user keeps the ID token's email", async () => {
    const { cookie, state } = await begin({}, "/", { email: "alice@example.com" });
    await callback({ code: "c1", state }, cookie);

    const [[sql, values]] = mockUnsafe.mock.calls.filter(([sql]) =>
      String(sql).startsWith("INSERT INTO users"),
    ) as unknown as [string, unknown[]][];
    const columns = sql.match(/\(([^)]*)\)/)![1].split(", ").slice(1);
    expect(Object.fromEntries(columns.map((column, i) => [column, values[i]]))).toEqual({
      username: "alice",
      auth_sub: "usr_alice",
      email: "alice@example.com",
    });
  });

  test("the account with the ID token's email signs in, even when the provider has not verified it", async () => {
    emailAccounts.set("alice@example.com", { user_id: "u-admin", username: "admin" });
    const { cookie, state } = await begin({}, "/", {
      email: "Alice@Example.com",
      email_verified: false,
    });
    const response = await callback({ code: "c1", state }, cookie);

    expect(response.headers.get("Location")).toBe("/");
    const [[sql, values]] = sessionWrites() as unknown as [string, unknown[]][];
    const columns = sql.match(/\(([^)]*)\)/)![1].split(", ").slice(1);
    expect(Object.fromEntries(columns.map((column, i) => [column, values[i]]))).toMatchObject({
      user_user_id: "u-admin",
      user_username: "admin",
    });
    const links = mockUnsafe.mock.calls.filter(([sql]) => String(sql).startsWith("UPDATE users SET"));
    expect(links.map(([, values]) => values)).toEqual([["usr_alice", "u-admin"]]);
  });

  test("a username taken by an unlinked local account is refused, with no session", async () => {
    const { cookie, state } = await begin({ username: "admin" });
    const response = await callback({ code: "c1", state }, cookie);
    expect(response.headers.get("Location")).toBe("/login?sso_error=account_exists");
    expect(clearsLoginCookie(response)).toBe(true);
    expect(sessionWrites()).toEqual([]);
  });

  test("a token with no role is refused", async () => {
    const { cookie, state } = await begin({ role: "" });
    const response = await callback({ code: "c1", state }, cookie);
    expect(response.headers.get("Location")).toBe("/login?sso_error=no_access");
    expect(sessionWrites()).toEqual([]);
  });

  test.each([
    ["no login cookie", { code: "c1" }, false, "expired"],
    ["a state from another sign-in", { code: "c1", state: "other" }, true, "expired"],
    ["the provider refusing access", { error: "access_denied" }, true, "no_access"],
    ["the provider failing", { error: "server_error" }, true, "failed"],
    ["no code", {}, true, "failed"],
  ] as const)("%s comes back to the sign-in page", async (_, query, withCookie, reason) => {
    const { cookie, state } = await begin();
    const params: Record<string, string> = { state, ...query };
    const response = await callback(params, withCookie ? cookie : undefined);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`/login?sso_error=${reason}`);
    expect(clearsLoginCookie(response)).toBe(true);
    expect(sessionWrites()).toEqual([]);
  });

  test("a code the provider refuses fails the sign-in", async () => {
    const { cookie, state } = await begin();
    issuer.state.token = () => json(400, { error: "invalid_grant" });
    const response = await callback({ code: "c1", state }, cookie);
    expect(response.headers.get("Location")).toBe("/login?sso_error=failed");
  });

  test("an unreachable provider fails the sign-in as unavailable", async () => {
    const { cookie, state } = await begin();
    issuer.state.down = true;
    const response = await callback({ code: "c1", state }, cookie);
    expect(response.headers.get("Location")).toBe("/login?sso_error=unavailable");
  });

  test("with single sign-on off, the route is unknown", async () => {
    configureSso(null);
    const res = fakeRes();
    expect(await getAuthCallbackRoute.execute(makeReq({ code: "c1" }), res)).toEqual({
      status: "error",
      message: "Not Found",
    });
    expect(res.statusCode).toBe(404);
  });
});
