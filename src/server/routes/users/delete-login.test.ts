/**
 * Tests for DELETE /api/login (#393 — partial: delete-login.ts coverage).
 *
 * The route calls `req.session.destroy(cb)` and returns success.
 * If the callback receives an error, the route throws — the Route base
 * class catches it and returns a 500 error envelope.
 */

import { describe, test, expect } from "bun:test";

import { deleteLoginRoute } from "./delete-login";

function makeReq(
  opts: { destroyErr?: Error } = {},
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
      regenerate() {},
      destroy(cb?: (err?: Error) => void) {
        destroyCalled = true;
        cb?.(opts.destroyErr);
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

  test("destroy callback error → Route layer surfaces 500 error envelope", async () => {
    const { req } = makeReq({ destroyErr: new Error("session store down") });
    const res = fakeRes();
    const result = await deleteLoginRoute.execute(req, res);
    expect(result?.status).toBe("error");
    expect((res as { statusCode: number }).statusCode).toBe(500);
  });
});