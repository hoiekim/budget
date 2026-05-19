/**
 * Tests for GET /api/login (#393 — partial: get-login.ts coverage).
 *
 * No external mocks needed — get-login reads `req.session.user` and the
 * exported `version` constant, no DB or downstream calls.
 */

import { describe, test, expect } from "bun:test";

import { version } from "server/lib/postgres/initialize";
import { getLoginRoute } from "./get-login";

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

  test("version field is a non-empty string", async () => {
    const result = await getLoginRoute.execute(makeReq(undefined), fakeRes());
    expect(typeof result?.body?.app?.version).toBe("string");
    expect(result?.body?.app?.version.length).toBeGreaterThan(0);
  });
});
