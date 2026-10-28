/**
 * Tests for GET /api/link-token.
 *
 * `plaid.isPlaidConfigured` is a top-level const computed at module load
 * from PLAID_* env vars; the test env has none, so it evaluates to false.
 * That gives the "not configured" path natural coverage; the configured
 * path (calling `plaid.getLinkToken`) would require a refactor to inject
 * dependencies — tracked as a separate follow-up issue.
 *
 * The item lookup (`getItem(user, item_id)`) is scoped to the requesting
 * user, so the ownership check is exercised here against the fake pg pool
 * even though the plaid call itself is unreachable in this env.
 */

import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakePg, restoreLeaves } from "test-helpers";

const { pg, mockQuery, resetQueryMocks } = createFakePg();

mock.module("pg", () => pg);

const { getLinkTokenRoute } = await import("./get-link-token");

afterAll(restoreLeaves);

beforeEach(() => {
  resetQueryMocks();
});

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

/** Raw items-table row matching ItemModel's full schema. */
const itemRow = (overrides: Record<string, unknown> = {}) => ({
  item_id: "i-1",
  user_id: "u-1",
  access_token: "access-production-secret",
  institution_id: null,
  available_products: null,
  cursor: null,
  status: null,
  status_reason: null,
  provider: "plaid",
  last_sync_status: null,
  last_sync_at: null,
  last_sync_error: null,
  raw: null,
  updated: null,
  is_deleted: false,
  ...overrides,
});

describe("get-link-token", () => {
  test("rejects unauthenticated requests", async () => {
    const result = await getLinkTokenRoute.execute(makeReq({}, { user: null }), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("create mode (no item_id): plaid not configured → failure", async () => {
    // Test env has no PLAID_* vars set; `isPlaidConfigured` is false at module load.
    const result = await getLinkTokenRoute.execute(makeReq({}), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/Plaid integration is not configured/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("item_id validation runs before the plaid-configured gate", async () => {
    // An array-shaped value must surface as a validation error, not the
    // unconfigured-Plaid failure.
    const result = await getLinkTokenRoute.execute(makeReq({ item_id: ["a", "b"] }), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/item_id/);
    expect(result?.message).not.toMatch(/Plaid integration is not configured/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("unknown item_id → 'Item not found' without touching plaid", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await getLinkTokenRoute.execute(makeReq({ item_id: "i-nope" }), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/Item not found/);
  });

  test("the ownership lookup is scoped to the requesting user", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await getLinkTokenRoute.execute(makeReq({ item_id: "i-1" }), fakeRes());
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(String(sql)).toMatch(/user_id/);
    expect(params).toContain("u-1");
    expect(params).toContain("i-1");
  });

  test("own item_id passes the ownership check and reaches the plaid gate", async () => {
    // The lookup returns the caller's own row; the request then fails only on
    // the unconfigured-Plaid gate, proving the stored credential — never a
    // caller-supplied token — is what would be handed to plaid.
    mockQuery.mockResolvedValueOnce({ rows: [itemRow()], rowCount: 1 });
    const result = await getLinkTokenRoute.execute(makeReq({ item_id: "i-1" }), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/Plaid integration is not configured/);
  });

  test("another user's item_id is not found (ownership enforced by the query)", async () => {
    // The row belongs to u-2; the user-scoped query returns nothing for u-1.
    mockQuery.mockImplementationOnce(async (_sql: unknown, params: unknown[]) => {
      const scoped = (params as string[]).includes("u-1");
      return { rows: scoped ? [] : [itemRow({ user_id: "u-2" })], rowCount: scoped ? 0 : 1 };
    });
    const result = await getLinkTokenRoute.execute(makeReq({ item_id: "i-1" }), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/Item not found/);
  });
});
