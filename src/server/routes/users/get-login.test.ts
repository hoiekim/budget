/**
 * Tests for GET /api/login. No external mocks needed — the route reads
 * `req.session.user` and the exported `version` constant.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { startFakeIssuer } from "test-issuer";

import { version } from "server/lib/postgres/initialize";
import { configureSso } from "server/lib/sso";
import { getLoginRoute } from "./get-login";

const issuer = startFakeIssuer();

afterAll(() => {
  configureSso(null);
  issuer.stop();
});

function makeReq(
  user?: { user_id: string; username: string },
): Parameters<typeof getLoginRoute.execute>[0] {
  return {
    method: "GET",
    path: "/login",
    url: "http://x/api/login",
    headers: {},
    query: {},
    body: undefined,
    session: {
      id: "s-1",
      user,
      regenerate() {},
      destroy() {},
    },
    ip: "127.0.0.1",
  } as unknown as Parameters<typeof getLoginRoute.execute>[0];
}

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
  return res as unknown as Parameters<typeof getLoginRoute.execute>[1];
};

describe("get-login", () => {
  test("no session.user → success with undefined user + 'Not logged in.' message", async () => {
    const result = await getLoginRoute.execute(makeReq(undefined), fakeRes());
    expect(result?.status).toBe("success");
    expect(result?.body?.user).toBeUndefined();
    expect(result?.body?.app?.version).toBe(version);
    expect(result?.message).toBe("Not logged in.");
  });

  test("authed session → success with the user echoed and no message", async () => {
    const user = { user_id: "u-1", username: "alice" };
    const result = await getLoginRoute.execute(makeReq(user), fakeRes());
    expect(result?.status).toBe("success");
    expect(result?.body?.user).toEqual(user);
    expect(result?.body?.app?.version).toBe(version);
    expect(result?.message).toBeUndefined();
  });

  test("with single sign-on off, password sign-in is the only way, as before", async () => {
    configureSso(null);
    const result = await getLoginRoute.execute(makeReq(undefined), fakeRes());
    expect(result?.body?.sso).toEqual({ enabled: false, localLogin: true });
  });

  test.each([
    [false, { enabled: true, localLogin: false }],
    [true, { enabled: true, localLogin: true }],
  ])("with single sign-on on and AUTH_LOCAL_LOGIN=%p, says so before anyone signs in", async (localLogin, sso) => {
    configureSso(issuer.config({ localLogin }));
    const result = await getLoginRoute.execute(makeReq(undefined), fakeRes());
    expect(result?.body?.sso).toEqual(sso);
    configureSso(null);
  });

  test("version field is a non-empty string", async () => {
    const result = await getLoginRoute.execute(makeReq(undefined), fakeRes());
    expect(typeof result?.body?.app?.version).toBe("string");
    expect(result?.body?.app?.version.length).toBeGreaterThan(0);
  });
});