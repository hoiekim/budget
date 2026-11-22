import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";

const { driver, mockUnsafe, resetSqlMocks } = createFakeSql();

mock.module("../../lib/postgres/sql-driver", () => driver);

const { postPublicTokenRoute } = await import("./post\-public\-token");

afterAll(restoreLeaves);

beforeEach(() => {
  resetSqlMocks();
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
  status_reason: null,
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
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("rejects missing provider query param", async () => {
    const result = await postPublicTokenRoute.execute(
      makeReq({}, { public_token: "t" }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/provider/);
  });

  test("provider=simple_fin with missing body → wrong-type failure, not a 500", async () => {
    // start.ts leaves req.body undefined when there is no JSON
    // content-type, the JSON is unparseable, or the payload is null.
    for (const body of [undefined, null]) {
      const result = await postPublicTokenRoute.execute(
        makeReq({ provider: "simple_fin" }, body),
        fakeRes(),
      );
      expect(result?.status).toBe("failed");
      expect(result?.message).toMatch(/wrong type of public_token/);
    }
  });

  test("provider=plaid with missing body → wrong-type failure, not a 500", async () => {
    for (const body of [undefined, null]) {
      const result = await postPublicTokenRoute.execute(
        makeReq({ provider: "plaid" }, body),
        fakeRes(),
      );
      expect(result?.status).toBe("failed");
      expect(result?.message).toMatch(/wrong type of public_token/);
    }
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

  test("provider=plaid with valid input but Plaid unconfigured → not-configured failure", async () => {
    // Test env has no PLAID_* vars, so plaid.isPlaidConfigured is false.
    // Validation runs first (see the wrong-type tests above); the config
    // guard fires only for well-formed requests.
    const result = await postPublicTokenRoute.execute(
      makeReq({ provider: "plaid" }, { public_token: "t", institution_id: "ins_1" }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/Plaid integration is not configured/);
  });

  test("provider=manual with existing MANUAL item → 'Manual item already exists' failure", async () => {
    // searchItems calls pool.query (via itemsTable.query). Returning a row
    // shaped like a MANUAL item makes the route's .find() succeed and
    // surface the "already exists" failure without ever touching plaid.
    mockUnsafe.mockResolvedValueOnce({
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
    expect(mockUnsafe).not.toHaveBeenCalled();
  });
});

describe("post-public-token provider=manual in a sharing group", () => {
  const ITEM_INSERT = /^\s*INSERT INTO items\b/i;

  type ManualItemBody = { item: Record<string, unknown> };

  /** The value a single-row INSERT binds to `column`, read off its own column list. */
  const boundTo = (insert: unknown[], column: string): unknown => {
    const [sql, values] = insert as [string, unknown[]];
    const [, columnList, valueList] = /\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i.exec(sql)!;
    const columns = columnList.split(",").map((c) => c.trim());
    const placeholders = valueList.split(",").map((p) => p.trim());
    return values[Number(placeholders[columns.indexOf(column)].slice(1)) - 1];
  };

  const itemInsert = () => mockUnsafe.mock.calls.find((call) => ITEM_INSERT.test(call[0] as string));

  test("the manual-item lookup covers the caller's sharing group and only manual items", async () => {
    await postPublicTokenRoute.execute(makeReq({ provider: "manual" }, {}), fakeRes());

    const [sql, values] = mockUnsafe.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/FROM items\b/i);
    expect(sql).toMatch(/user_id = ANY\(sharing_user_ids\(\$1\)\)/);
    expect(sql).toMatch(/provider = \$2/);
    expect(values).toEqual(["u-1", "manual"]);
  });

  test("another member's manual item does not block creating the caller's own", async () => {
    mockUnsafe.mockResolvedValueOnce({
      rows: [itemRow({ item_id: "i-peer", user_id: "u-peer", provider: "manual" })],
      rowCount: 1,
    });

    const result = await postPublicTokenRoute.execute(makeReq({ provider: "manual" }, {}), fakeRes());

    expect(result?.status).toBe("success");
    const { item } = (result as unknown as { body: ManualItemBody }).body;
    expect(item.user_id).toBe("u-1");
    expect(item.provider).toBe("manual");
    expect(item.item_id).not.toBe("i-peer");
    expect(item).not.toHaveProperty("access_token");

    const insert = itemInsert();
    expect(insert).toBeDefined();
    expect(boundTo(insert!, "user_id")).toBe("u-1");
    expect(boundTo(insert!, "item_id")).toBe(item.item_id);
    expect(boundTo(insert!, "provider")).toBe("manual");
    expect(insert![1]).not.toContain("u-peer");
  });

  test("with no manual item in the group the caller's is created and returned as theirs", async () => {
    const result = await postPublicTokenRoute.execute(
      makeReq({ provider: "manual" }, {}, { user: { user_id: "u-solo", username: "solo" } }),
      fakeRes(),
    );

    expect(result?.status).toBe("success");
    const { item } = (result as unknown as { body: ManualItemBody }).body;
    expect(item.user_id).toBe("u-solo");
    expect(boundTo(itemInsert()!, "user_id")).toBe("u-solo");
  });

  test("the caller's own manual item still refuses a second one, even beside another member's", async () => {
    mockUnsafe.mockResolvedValueOnce({
      rows: [
        itemRow({ item_id: "i-peer", user_id: "u-peer", provider: "manual" }),
        itemRow({ item_id: "i-own", user_id: "u-1", provider: "manual" }),
      ],
      rowCount: 2,
    });

    const result = await postPublicTokenRoute.execute(makeReq({ provider: "manual" }, {}), fakeRes());

    expect(result).toEqual({ status: "failed", message: "Manual item already exists for the user" });
    expect(itemInsert()).toBeUndefined();
  });
});
