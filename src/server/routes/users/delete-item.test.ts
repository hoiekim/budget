// Per-test-bundle isolation — see scripts/test-bundled/.
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { bundleOf } from "test-bundled";

const mockQuery = mock(async (_sql: string, _values?: unknown[]) => ({
  rows: [] as unknown[],
  rowCount: 0 as number | null,
}));

class FakePool {
  query = mockQuery;
  end = async () => {};
  connect = async () => ({ query: mockQuery, release: () => {} });
}

mock.module("pg", () => ({
  Pool: FakePool,
  types: { setTypeParser: () => {} },
  default: { Pool: FakePool, types: { setTypeParser: () => {} } },
}));

const { deleteItemRoute } = await bundleOf<typeof import("./delete\-item")>(import.meta.url);

beforeEach(() => {
  mockQuery.mockReset();
});

function makeReq(
  query: Record<string, unknown>,
  opts: { user?: { user_id: string; username: string } | null } = {},
): Parameters<typeof deleteItemRoute.execute>[0] {
  const user = opts.user === undefined ? { user_id: "u-1", username: "test" } : opts.user;
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

/**
 * Build a raw items-table row that `ItemModel`'s mapper will accept.
 * The model needs every column to be present (null is fine, undefined
 * is not), so this returns the full row shape with sensible defaults.
 */
const makeItemRow = (overrides: Record<string, unknown> = {}) => ({
  item_id: "i-A",
  user_id: "u-1",
  access_token: "no_access_token",
  institution_id: null,
  available_products: null,
  cursor: null,
  status: null,
  provider: "manual",
  last_sync_status: null,
  last_sync_at: null,
  last_sync_error: null,
  raw: null,
  updated: null,
  is_deleted: false,
  ...overrides,
});

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
    // User u-1 asks to delete an item that returns no rows in their scope.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await deleteItemRoute.execute(
      makeReq({ id: "i-belongs-to-other" }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not owned by the request user/);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    // SELECT was scoped to the caller's user_id — pinned at the SQL layer
    // by `WHERE user_id = $N`.
    const [, values] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(values).toContain("u-1");
  });

  test("item exists but for a different item_id → 'not owned' failure", async () => {
    // Caller owns i-A, but requests deletion of i-B.
    mockQuery.mockResolvedValueOnce({
      rows: [makeItemRow({ item_id: "i-A" })],
      rowCount: 1,
    });

    const result = await deleteItemRoute.execute(makeReq({ id: "i-B" }), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not owned by the request user/);
  });
});
