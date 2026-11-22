// Route + repo coverage for the manual-account mint endpoint
// (`GET /api/new-account` — provider-gated to MANUAL). Mirrors the
// sibling `get-new-transaction-routes.test.ts` shape: driver-FakeSQL +
// SQL router by table, seeded item row, INSERT into accounts.
//
// What we're pinning here:
//   - unauth / missing-arg / not-found rejections
//   - provider gate (mint refused on Plaid/simple-fin items)
//   - happy path writes a `manual-<uuid>` account_id, binds the user's id,
//     defaults institution_id to "Unknown", and never touches the `raw` column.
// Without these, dropping the provider check or the raw-strip would pass silently.

import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";

const { driver, mockUnsafe, clearSqlMocks } = createFakeSql();

mock.module("../../lib/postgres/sql-driver", () => driver);

const { getNewAccountRoute } = await import("./get-new-account");

afterAll(restoreLeaves);

// SQL router state — each test seeds which SELECT-per-table returns a row.
type MaybeRow = Record<string, unknown> | null;
let itemRow: MaybeRow = null;
let insertShouldFail = false;

const queryRouter = async (sql: string, values?: unknown[]) => {
  const isSelect = /^\s*SELECT\b/i.test(sql);
  if (isSelect && /\bFROM\s+items\b/i.test(sql)) {
    return itemRow ? { rows: [itemRow], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/\bINSERT\s+INTO\s+accounts\b/i.test(sql)) {
    if (insertShouldFail) throw new Error("DB down");
    return { rows: [insertStub(values as unknown[])], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
};

function insertStub(values: unknown[]): Record<string, unknown> {
  const minted = values.find((v) => typeof v === "string" && (v as string).startsWith("manual-"));
  return {
    account_id: String(minted ?? "manual-stub"),
    user_id: "u-1",
    item_id: "item-manual",
    institution_id: "Unknown",
    name: "Unknown",
    type: "other",
    subtype: null,
    balances_available: null,
    balances_current: null,
    balances_limit: null,
    balances_iso_currency_code: null,
    custom_name: null,
    hide: null,
    archived: null,
    label_budget_id: null,
    graph_options_use_snapshots: null,
    graph_options_use_holding_snapshots: null,
    graph_options_use_transactions: null,
    raw: null,
    updated: new Date().toISOString(),
    is_deleted: false,
  };
}

const findInsert = (): { sql: string; values: unknown[] } | null => {
  for (const call of mockUnsafe.mock.calls) {
    const sql = call[0] as string;
    if (/\bINSERT\s+INTO\s+accounts\b/i.test(sql)) return { sql, values: call[1] as unknown[] };
  }
  return null;
};

function makeReq(query: Record<string, string> = {}, userId?: string) {
  return {
    method: "GET",
    path: "/x",
    url: "http://x/api/x?" + new URLSearchParams(query).toString(),
    headers: {},
    query,
    body: undefined,
    session: {
      id: "s-1",
      user: userId ? { user_id: userId, username: "test" } : undefined,
      regenerate() {},
      destroy() {},
    },
    ip: "127.0.0.1",
  } as unknown as Parameters<typeof getNewAccountRoute.execute>[0];
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
  }) as unknown as Parameters<typeof getNewAccountRoute.execute>[1];

beforeEach(() => {
  clearSqlMocks();
  mockUnsafe.mockImplementation(queryRouter);
  itemRow = null;
  insertShouldFail = false;
});

const nullFields = (keys: string[]): Record<string, null> =>
  Object.fromEntries(keys.map((k) => [k, null]));

const ITEM_NULLABLE = [
  "access_token",
  "institution_id",
  "available_products",
  "cursor",
  "status",
  "status_reason",
  "provider",
  "last_sync_status",
  "last_sync_at",
  "last_sync_error",
  "raw",
  "updated",
  "is_deleted",
];

const manualItem = () => ({
  ...nullFields(ITEM_NULLABLE),
  item_id: "item-manual",
  user_id: "u-1",
  provider: "manual",
});

const plaidItem = () => ({
  ...nullFields(ITEM_NULLABLE),
  item_id: "item-plaid",
  user_id: "u-1",
  provider: "plaid",
});

describe("get-new-account route", () => {
  test("rejects unauthenticated requests", async () => {
    const result = await getNewAccountRoute.execute(makeReq({ item_id: "item-manual" }), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/i);
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("rejects a missing item_id", async () => {
    const result = await getNewAccountRoute.execute(makeReq({}, "u-1"), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/item_id/i);
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("rejects when the item isn't found for the caller", async () => {
    const result = await getNewAccountRoute.execute(makeReq({ item_id: "item-x" }, "u-1"), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/item not found/i);
    expect(findInsert()).toBeNull();
  });

  test("rejects when the item is not MANUAL provider (Plaid/simple-fin)", async () => {
    itemRow = plaidItem();
    const result = await getNewAccountRoute.execute(makeReq({ item_id: "item-plaid" }, "u-1"), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/manual items/i);
    expect(findInsert()).toBeNull();
  });

  test("happy path: manual item → INSERT with a manual-<uuid> id, bound to the caller's user_id", async () => {
    itemRow = manualItem();
    const result = await getNewAccountRoute.execute(makeReq({ item_id: "item-manual" }, "u-1"), fakeRes());
    expect(result?.status).toBe("success");
    const insert = findInsert();
    expect(insert).not.toBeNull();
    expect(insert!.values).toContain("u-1");
    expect(insert!.values).toContain("item-manual");
    const manualIds = insert!.values.filter(
      (v): v is string => typeof v === "string" && v.startsWith("manual-"),
    );
    expect(manualIds.length).toBeGreaterThan(0);
    expect(typeof (result?.body as { account_id: string }).account_id).toBe("string");
  });

  test("defaults institution_id to \"Unknown\" — the sync-loop sentinel", async () => {
    itemRow = manualItem();
    await getNewAccountRoute.execute(makeReq({ item_id: "item-manual" }, "u-1"), fakeRes());
    const insert = findInsert();
    expect(insert!.values).toContain("Unknown");
  });

  test("does not write the `raw` column — no provider payload for a manual account", async () => {
    itemRow = manualItem();
    await getNewAccountRoute.execute(makeReq({ item_id: "item-manual" }, "u-1"), fakeRes());
    const insert = findInsert();
    expect(insert!.sql).not.toMatch(/\braw\b/);
  });

  test("surfaces a DB error as a failed response (no throw bubbling to the caller)", async () => {
    itemRow = manualItem();
    insertShouldFail = true;
    const result = await getNewAccountRoute.execute(makeReq({ item_id: "item-manual" }, "u-1"), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/failed to create/i);
  });
});

describe("mint on an item someone else in the sharing group owns", () => {
  const OWNER_LOOKUP = /\bFROM\s+items\s+r\s+JOIN\s+users\b/i;
  let ownerRow: MaybeRow = null;

  beforeEach(() => {
    ownerRow = null;
    // The owner lookup joins `users`; every other statement keeps the table router.
    mockUnsafe.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (OWNER_LOOKUP.test(sql)) {
        return ownerRow ? { rows: [ownerRow], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      return queryRouter(sql, values);
    });
  });

  /** The value a single-row INSERT binds to `column`, read off its own column list. */
  const boundTo = (insert: { sql: string; values: unknown[] }, column: string): unknown => {
    const [, columnList, valueList] = /\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i.exec(insert.sql)!;
    const columns = columnList.split(",").map((c) => c.trim());
    const placeholders = valueList.split(",").map((p) => p.trim());
    return insert.values[Number(placeholders[columns.indexOf(column)].slice(1)) - 1];
  };

  const ownerLookup = () => mockUnsafe.mock.calls.find((call) => OWNER_LOOKUP.test(call[0] as string));

  test("the account is inserted under the item owner's user_id", async () => {
    itemRow = { ...manualItem(), user_id: "u-owner" };
    ownerRow = { user_id: "u-owner", username: "owner" };

    const result = await getNewAccountRoute.execute(makeReq({ item_id: "item-manual" }, "u-member"), fakeRes());

    expect(result?.status).toBe("success");
    const insert = findInsert();
    expect(insert).not.toBeNull();
    expect(boundTo(insert!, "user_id")).toBe("u-owner");
    expect(insert!.values).not.toContain("u-member");
    expect(boundTo(insert!, "item_id")).toBe("item-manual");
  });

  test("the owner lookup is keyed on the item and scoped to the caller's sharing group", async () => {
    itemRow = { ...manualItem(), user_id: "u-owner" };
    ownerRow = { user_id: "u-owner", username: "owner" };

    await getNewAccountRoute.execute(makeReq({ item_id: "item-manual" }, "u-member"), fakeRes());

    const lookup = ownerLookup();
    expect(lookup).toBeDefined();
    expect(lookup![0] as string).toMatch(/r\.item_id = \$1 AND r\.user_id = ANY\(sharing_user_ids\(\$2\)\)/);
    expect(lookup![1]).toEqual(["item-manual", "u-member"]);
  });

  test("no owner in reach answers 'Item not found.' and inserts nothing", async () => {
    // The manual item resolves, so only the owner lookup can refuse.
    itemRow = { ...manualItem(), user_id: "u-owner" };
    ownerRow = null;

    const result = await getNewAccountRoute.execute(makeReq({ item_id: "item-manual" }, "u-member"), fakeRes());

    expect(result).toEqual({ status: "failed", message: "Item not found." });
    expect(ownerLookup()).toBeDefined();
    expect(findInsert()).toBeNull();
  });
});
