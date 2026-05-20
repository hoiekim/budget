/**
 * Tests for GET /api/link-token (#393 — partial: get-link-token.ts coverage).
 *
 * `plaid.isPlaidConfigured` is a top-level const computed at module load
 * from PLAID_* env vars; the test env has none, so it evaluates to false.
 * That gives the "not configured" path natural coverage; the configured
 * path (calling `plaid.getLinkToken`) would require a refactor to inject
 * dependencies — tracked as a separate follow-up issue.
 */

import { describe, test, expect } from "bun:test";

import { getLinkTokenRoute } from "./get-link-token";

function makeReq(
  query: Record<string, unknown>,
  opts: { user?: { user_id: string; username: string } | null } = {},
): Parameters<typeof getLinkTokenRoute.execute>[0] {
  const user =
    opts.user === undefined ? { user_id: "u-1", username: "test" } : opts.user;
  return {
    method: "GET",
    path: "/link-token",
    url: "http://x/api/link-token",
    headers: {},
    query,
    body: undefined,
    session: {
      id: "s-1",
      user: user ?? undefined,
      regenerate() {},
      destroy() {},
    },
    ip: "127.0.0.1",
  } as unknown as Parameters<typeof getLinkTokenRoute.execute>[0];
}

const fakeRes = () =>
  ({
    statusCode: 200,
    headersSent: false,
    status() {
      return this;
    },
    write() {
      return true;
    },
    end() {},
  }) as unknown as Parameters<typeof getLinkTokenRoute.execute>[1];

describe("get-link-token", () => {
  test("rejects unauthenticated requests", async () => {
    const result = await getLinkTokenRoute.execute(makeReq({}, { user: null }), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/);
  });

  test("plaid not configured → 'Plaid integration is not configured' failure", async () => {
    // Test env has no PLAID_* vars set; `isPlaidConfigured` is false at module load.
    const result = await getLinkTokenRoute.execute(makeReq({}), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/Plaid integration is not configured/);
  });

  test("plaid not configured short-circuits before access_token validation", async () => {
    // If access_token validation ran first, an array-shaped value would surface
    // as "Parameter access_token must be a single value". The route is expected
    // to return the unconfigured-Plaid failure first.
    const result = await getLinkTokenRoute.execute(
      makeReq({ access_token: ["a", "b"] }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/Plaid integration is not configured/);
    expect(result?.message).not.toMatch(/access_token/);
  });
});
