import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";
import { eventToken, startFakeIssuer } from "test-issuer";

const { driver, mockUnsafe, resetSqlMocks } = createFakeSql();
mock.module("../../lib/postgres/sql-driver", () => driver);

const { postAuthEventsRoute } = await import("./post-auth-events");
const { configureSso } = await import("server/lib/sso");

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

const makeReq = (rawBody: string | undefined) =>
  ({
    method: "POST",
    path: "/auth/events",
    url: "https://budget.example.test/api/auth/events",
    headers: { "content-type": "application/secevent+jwt" },
    query: {},
    body: undefined,
    rawBody,
    session: { id: "s-1", user: undefined, regenerate() {}, destroy() {} },
    ip: "127.0.0.1",
  }) as unknown as Parameters<typeof postAuthEventsRoute.execute>[0];

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
  return res as unknown as Parameters<typeof postAuthEventsRoute.execute>[1] & { statusCode: number };
};

const post = async (rawBody: string | undefined) => {
  const res = fakeRes();
  const result = await postAuthEventsRoute.execute(makeReq(rawBody), res);
  return { status: res.statusCode, result };
};

describe("POST /api/auth/events", () => {
  test("a verified event is applied and acknowledged with 202", async () => {
    const { status, result } = await post(eventToken({ "session.ended": { sid: "ses_1" } }));
    expect(status).toBe(202);
    expect(result).toEqual({ status: "success" });
    expect(mockUnsafe.mock.calls.map(([sql, values]) => [sql, values])).toEqual([
      ["DELETE FROM sessions WHERE auth_sid = $1 RETURNING session_id", ["ses_1"]],
    ]);
  });

  test("an event of a kind budget does not use is still acknowledged", async () => {
    const { status } = await post(eventToken({ "invite.accepted": { invite: "inv_1", sub: "usr_alice" } }));
    expect(status).toBe(202);
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test.each([
    ["a token signed for another audience", eventToken({ "user.disabled": { sub: "usr_alice" } }, { aud: "wiki" })],
    ["a body that is not a token", "not-a-jwt"],
    ["no body", undefined],
  ])("%s is refused with 400 and changes nothing", async (_, body) => {
    const { status, result } = await post(body);
    expect(status).toBe(400);
    expect(result).toEqual({ status: "failed", message: "Invalid security event token." });
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("an unreachable provider answers 503, so the provider delivers it again", async () => {
    issuer.state.down = true;
    const { status } = await post(eventToken({ "user.disabled": { sub: "usr_alice" } }));
    expect(status).toBe(503);
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("with single sign-on off, the route is unknown", async () => {
    configureSso(null);
    const { status, result } = await post(eventToken({ "user.disabled": { sub: "usr_alice" } }));
    expect(status).toBe(404);
    expect(result).toEqual({ status: "error", message: "Not Found" });
  });
});
