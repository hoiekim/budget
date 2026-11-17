import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { TEST_ISSUER, startFakeIssuer } from "test-issuer";

import type { SessionAuth } from "server/lib/postgres/models/session";
import { configureSso } from "server/lib/sso";
import { deleteLoginRoute } from "./delete-login";

const issuer = startFakeIssuer();

afterAll(() => {
  configureSso(null);
  issuer.stop();
});

beforeEach(() => {
  issuer.reset();
  configureSso(null);
});

function makeReq(
  opts: { destroyErr?: Error; auth?: SessionAuth } = {},
): { req: Parameters<typeof deleteLoginRoute.execute>[0]; destroyCalled: () => boolean } {
  let destroyCalled = false;
  const req = {
    method: "DELETE",
    path: "/login",
    url: "http://x/api/login",
    headers: {},
    query: {},
    body: undefined,
    session: {
      id: "s-1",
      user: undefined,
      auth: opts.auth,
      async regenerate() {},
      async destroy() {
        destroyCalled = true;
        await Promise.resolve();
        if (opts.destroyErr) throw opts.destroyErr;
      },
    },
    ip: "127.0.0.1",
  } as unknown as Parameters<typeof deleteLoginRoute.execute>[0];
  return { req, destroyCalled: () => destroyCalled };
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
  return res as unknown as Parameters<typeof deleteLoginRoute.execute>[1];
};

describe("delete-login", () => {
  test("happy path → session.destroy called, success returned", async () => {
    const { req, destroyCalled } = makeReq();
    const result = await deleteLoginRoute.execute(req, fakeRes());
    expect(destroyCalled()).toBe(true);
    expect(result?.status).toBe("success");
  });

  test("session store delete fails → 500 error envelope, not success", async () => {
    const { req } = makeReq({ destroyErr: new Error("session store down") });
    const res = fakeRes();
    const result = await deleteLoginRoute.execute(req, res);
    expect(result?.status).toBe("error");
    expect((res as { statusCode: number }).statusCode).toBe(500);
  });

  test("with single sign-on on, a password session signs out as before", async () => {
    configureSso(issuer.config(), { fetch: issuer.fetch });
    const { req, destroyCalled } = makeReq();
    expect(await deleteLoginRoute.execute(req, fakeRes())).toEqual({ status: "success" });
    expect(destroyCalled()).toBe(true);
    expect(issuer.state.seen).toEqual([]);
  });

  describe("a single sign-on session", () => {
    const auth: SessionAuth = { sid: "ses_1", refreshToken: "rt_1", recheckAt: new Date() };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

    test("also revokes its refresh token and hands back the provider's sign-out URL", async () => {
      configureSso(issuer.config(), { fetch: issuer.fetch });
      const { req, destroyCalled } = makeReq({ auth });
      const result = await deleteLoginRoute.execute(req, fakeRes());

      expect(destroyCalled()).toBe(true);
      const logoutUrl = new URL(result?.body?.logoutUrl ?? "");
      expect(logoutUrl.origin + logoutUrl.pathname).toBe(`${TEST_ISSUER}/logout`);
      expect(logoutUrl.searchParams.get("client_id")).toBe("budget");
      expect(logoutUrl.searchParams.get("post_logout_redirect_uri")).toBe("https://budget.example.test/");
      await settle();
      expect(issuer.seen("/oauth/revoke")[0].form.get("token")).toBe("rt_1");
    });

    test("signs out even when the provider fails to revoke", async () => {
      configureSso(issuer.config(), { fetch: issuer.fetch });
      issuer.state.revoke = () => new Response(null, { status: 400 });
      const { req, destroyCalled } = makeReq({ auth });
      const result = await deleteLoginRoute.execute(req, fakeRes());
      expect(result?.status).toBe("success");
      expect(destroyCalled()).toBe(true);
      await settle();
    });

    test("signs out even when the provider is unreachable, without a sign-out URL", async () => {
      configureSso(issuer.config(), { fetch: issuer.fetch });
      issuer.state.down = true;
      const { req, destroyCalled } = makeReq({ auth });
      expect(await deleteLoginRoute.execute(req, fakeRes())).toEqual({ status: "success" });
      expect(destroyCalled()).toBe(true);
      await settle();
    });
  });
});
