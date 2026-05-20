/**
 * Tests for POST /api/public-token (#393 — partial: post-public-token.ts
 * validation and dispatch coverage).
 *
 * Scope: auth gate, provider-routing validation, and the wrong-type
 * branches. The success branches for SIMPLE_FIN / PLAID / MANUAL all
 * call into `plaid.*` / `simpleFin.*` (namespace re-exports) and
 * `upsertItems` / `searchItems` / `sync*` (top-level consts in
 * server/lib). Mocking either layer cleanly requires either DI on the
 * route or a process-wide `mock.module`, which the test-pattern note
 * explicitly avoids (cross-file leak). The MANUAL "already exists"
 * branch is covered because it only requires `itemsTable.query` to
 * return a matching row, which is monkey-patchable in-place.
 *
 * Remaining branches (SIMPLE_FIN success, PLAID success, MANUAL fresh)
 * are tracked as a follow-up to #393.
 */

import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";

import { itemsTable } from "server/lib/postgres/models";
import { postPublicTokenRoute } from "./post-public-token";

const originalQuery = itemsTable.query.bind(itemsTable);

const mockQuery = mock(async (_filters: Record<string, unknown>): Promise<unknown[]> => []);

(itemsTable as unknown as { query: typeof mockQuery }).query = mockQuery;

afterAll(() => {
  (itemsTable as unknown as { query: typeof originalQuery }).query = originalQuery;
});

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue([]);
});

function makeReq(
  query: Record<string, unknown>,
  body: unknown,
  opts: { user?: { user_id: string; username: string } | null } = {},
): Parameters<typeof postPublicTokenRoute.execute>[0] {
  const user =
    opts.user === undefined ? { user_id: "u-1", username: "test" } : opts.user;
  return {
    method: "POST",
    path: "/public-token",
    url: "http://x/api/public-token",
    headers: {},
    query,
    body,
    session: {
      id: "s-1",
      user: user ?? undefined,
      regenerate() {},
      destroy() {},
    },
    ip: "127.0.0.1",
  } as unknown as Parameters<typeof postPublicTokenRoute.execute>[0];
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
  }) as unknown as Parameters<typeof postPublicTokenRoute.execute>[1];

describe("post-public-token", () => {
  test("rejects unauthenticated requests", async () => {
    const result = await postPublicTokenRoute.execute(
      makeReq({ provider: "simple_fin" }, { public_token: "t" }, { user: null }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("rejects missing provider query param", async () => {
    const result = await postPublicTokenRoute.execute(
      makeReq({}, { public_token: "t" }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/provider/);
  });

  test("provider=simple_fin with non-string public_token → wrong-type failure", async () => {
    const result = await postPublicTokenRoute.execute(
      makeReq({ provider: "simple_fin" }, { public_token: 42 }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/wrong type of public_token/);
  });

  test("provider=plaid with non-string public_token → wrong-type failure", async () => {
    const result = await postPublicTokenRoute.execute(
      makeReq({ provider: "plaid" }, { public_token: 1, institution_id: "ins_1" }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/wrong type of public_token/);
  });

  test("provider=plaid with non-string institution_id → wrong-type failure", async () => {
    const result = await postPublicTokenRoute.execute(
      makeReq({ provider: "plaid" }, { public_token: "t", institution_id: 1 }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/wrong type of public_token/);
  });

  test("provider=manual with existing MANUAL item → 'Manual item already exists' failure", async () => {
    // `searchItems` is the only call before the existing-item check; it walks
    // `itemsTable.query` and filters by user. Returning a MANUAL row makes the
    // .find() succeed → route hits the failure branch without touching plaid.
    const manualRow = {
      toJSON: () => ({
        item_id: "i-existing",
        provider: "manual", // ItemProvider.MANUAL = "manual"
        access_token: "no_access_token",
      }),
    };
    mockQuery.mockResolvedValueOnce([manualRow]);

    const result = await postPublicTokenRoute.execute(
      makeReq({ provider: "manual" }, {}),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/Manual item already exists/);
  });

  test("unknown provider value → wrong-type-of-provider failure", async () => {
    const result = await postPublicTokenRoute.execute(
      makeReq({ provider: "carrier_pigeon" }, {}),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/wrong type of provider/);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
