/**
 * Tests for DELETE /api/item (#393 — partial: delete-item.ts coverage).
 *
 * Scope: auth gate, missing-id validation, and the cross-user ownership
 * check via `searchItems`. The plaid / non-plaid dispatch on the
 * happy-path (calls into `plaid.deleteItem` + the items.ts `deleteItem`
 * that wraps `withTransaction` + 6 different tables) is left for a
 * follow-up that introduces dependency injection at the route layer.
 * Mocking the namespace + every table here would be fragile and would
 * leak across sibling test files.
 */

import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";

import { itemsTable } from "server/lib/postgres/models";
import { deleteItemRoute } from "./delete-item";

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
  opts: { user?: { user_id: string; username: string } | null } = {},
): Parameters<typeof deleteItemRoute.execute>[0] {
  const user =
    opts.user === undefined ? { user_id: "u-1", username: "test" } : opts.user;
  return {
    method: "DELETE",
    path: "/item",
    url: "http://x/api/item",
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
  } as unknown as Parameters<typeof deleteItemRoute.execute>[0];
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
  }) as unknown as Parameters<typeof deleteItemRoute.execute>[1];

describe("delete-item", () => {
  test("rejects unauthenticated requests", async () => {
    const result = await deleteItemRoute.execute(
      makeReq({ id: "i-1" }, { user: null }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("rejects missing id query param", async () => {
    const result = await deleteItemRoute.execute(makeReq({}), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/Missing required parameter: id/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("cross-user attempt: item not in caller's items → 'not owned' failure", async () => {
    // User u-1 asks to delete item i-belongs-to-other. `searchItems(user)`
    // returns the caller's items only — emulate "caller owns nothing".
    mockQuery.mockResolvedValueOnce([]);

    const result = await deleteItemRoute.execute(
      makeReq({ id: "i-belongs-to-other" }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not owned by the request user/);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [filters] = mockQuery.mock.calls[0] as [Record<string, unknown>];
    expect(filters.user_id).toBe("u-1");
  });

  test("item exists but for a different item_id → 'not owned' failure", async () => {
    // Caller owns i-A, but requests deletion of i-B.
    const otherRow = {
      toJSON: () => ({
        item_id: "i-A",
        provider: "manual", // ItemProvider.MANUAL = "manual"
        access_token: "no_access_token",
      }),
    };
    mockQuery.mockResolvedValueOnce([otherRow]);

    const result = await deleteItemRoute.execute(makeReq({ id: "i-B" }), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not owned by the request user/);
  });
});
