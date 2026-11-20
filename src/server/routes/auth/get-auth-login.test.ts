import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { TEST_ISSUER, TEST_REDIRECT_URI, startFakeIssuer } from "test-issuer";
import { configureSso } from "server/lib/sso";
import { getAuthLoginRoute } from "./get-auth-login";

const issuer = startFakeIssuer();

afterAll(() => {
  configureSso(null);
  issuer.stop();
});

beforeEach(() => {
  issuer.reset();
  configureSso(issuer.config(), { fetch: issuer.fetch });
});

const makeReq = (query: Record<string, string> = {}) => {
  const url = new URL("https://budget.example.test/api/auth/login");
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return {
    method: "GET",
    path: "/auth/login",
    url: url.toString(),
    headers: {},
    query,
    body: undefined,
    session: { id: "s-1", user: undefined, regenerate() {}, destroy() {} },
    ip: "127.0.0.1",
  } as unknown as Parameters<typeof getAuthLoginRoute.execute>[0];
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
  return res as unknown as Parameters<typeof getAuthLoginRoute.execute>[1] & { statusCode: number };
};

/** The login cookie's saved request, which the callback reads back. */
const savedLogin = (setCookie: string) => {
  const value = setCookie.split(";")[0].split("=")[1];
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
};

describe("GET /api/auth/login", () => {
  test("redirects to the identity provider and sets the login cookie", async () => {
    const result = (await getAuthLoginRoute.execute(
      makeReq({ returnTo: "/budgets?view_date=2026-11" }),
      fakeRes(),
    )) as Response;

    expect(result.status).toBe(302);
    const location = new URL(result.headers.get("Location")!);
    expect(location.origin + location.pathname).toBe(`${TEST_ISSUER}/oauth/authorize`);
    expect(location.searchParams.get("client_id")).toBe("budget");
    expect(location.searchParams.get("redirect_uri")).toBe(TEST_REDIRECT_URI);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");

    const setCookie = result.headers.get("Set-Cookie")!;
    expect(setCookie).toStartWith("__Host-login=");
    expect(setCookie).toContain("HttpOnly");
    expect(savedLogin(setCookie).returnTo).toBe("/budgets?view_date=2026-11");
    expect(savedLogin(setCookie).state).toBe(location.searchParams.get("state"));
  });

  test("a returnTo that leaves the app lands on / instead", async () => {
    const result = (await getAuthLoginRoute.execute(
      makeReq({ returnTo: "https://evil.example.com/" }),
      fakeRes(),
    )) as Response;
    expect(savedLogin(result.headers.get("Set-Cookie")!).returnTo).toBe("/");
  });

  test("an unreachable provider sends the browser back to the sign-in page", async () => {
    issuer.state.down = true;
    const result = (await getAuthLoginRoute.execute(makeReq(), fakeRes())) as Response;
    expect(result.status).toBe(302);
    expect(result.headers.get("Location")).toBe("/login?sso_error=unavailable");
  });

  test("with single sign-on off, the route is unknown", async () => {
    configureSso(null);
    const res = fakeRes();
    const result = await getAuthLoginRoute.execute(makeReq(), res);
    expect(res.statusCode).toBe(404);
    expect(result).toEqual({ status: "error", message: "Not Found" });
    expect(issuer.state.seen).toEqual([]);
  });
});
