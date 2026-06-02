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

const { postPublicTokenRoute } = await bundleOf<typeof import("./post\-public\-token")>(import.meta.url);

beforeEach(() => {
  mockQuery.mockReset();
});

function makeReq(
  query: Record<string, unknown>,
  body: unknown,
  opts: { user?: { user_id: string; username: string } | null } = {},
): Parameters<typeof postPublicTokenRoute.execute>[0] {
  const user = opts.user === undefined ? { user_id: "u-1", username: "test" } : opts.user;
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

/** Raw items-table row matching ItemModel's full schema. */
const itemRow = (overrides: Record<string, unknown> = {}) => ({
  item_id: "i-existing",
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
    // searchItems calls pool.query (via itemsTable.query). Returning a row
    // shaped like a MANUAL item makes the route's .find() succeed and
    // surface the "already exists" failure without ever touching plaid.
    mockQuery.mockResolvedValueOnce({
      rows: [itemRow({ item_id: "i-existing", provider: "manual" })],
      rowCount: 1,
    });

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
