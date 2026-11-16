// Route-level tests for the nine delete routes (#889): the destructive-path
// guards — auth, the id validation, the ownership lookup, and the
// manual-source / manual-provider gates — never executed in the test suite
// before this file: no test file imported any of these route modules.
//
// Routing rather than a per-call queue keeps the test robust to the extra
// writes the cascades emit: only the five lookup SELECTs are scripted
// (transactions, investment_transactions, accounts, items, sections);
// everything else falls through to one affected row. `withTransaction`
// (deleteAccounts, deleteBudget, deleteSection) reaches the database through
// the reserved client, so in-transaction statements are asserted against
// `mockReservedUnsafe`, never `mockUnsafe` (see `test-helpers.ts`).
import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";

let txRows: Record<string, unknown>[] = [];
let invTxRows: Record<string, unknown>[] = [];
let accountRows: Record<string, unknown>[] = [];
let itemRows: Record<string, unknown>[] = [];
let sectionRows: Record<string, unknown>[] = [];

const { driver, mockUnsafe, mockReservedUnsafe, resetSqlMocks } = createFakeSql(
  async (sql: string) => {
    const isSelect = /^\s*SELECT\b/i.test(sql);
    if (isSelect) {
      if (/from\s+investment_transactions\b/i.test(sql)) {
        return { rows: invTxRows, rowCount: invTxRows.length };
      }
      if (/from\s+transactions\b/i.test(sql)) {
        return { rows: txRows, rowCount: txRows.length };
      }
      if (/from\s+accounts\b/i.test(sql)) {
        return { rows: accountRows, rowCount: accountRows.length };
      }
      if (/from\s+items\b/i.test(sql)) {
        return { rows: itemRows, rowCount: itemRows.length };
      }
      if (/from\s+sections\b/i.test(sql)) {
        return { rows: sectionRows, rowCount: sectionRows.length };
      }
      return { rows: [], rowCount: 0 };
    }
    // INSERT / UPDATE / upsert and anything else: report one affected row.
    return { rows: [{ ok: true }], rowCount: 1 };
  },
);

mock.module("../lib/postgres/sql-driver", () => driver);

// `mock.module` is process-global in Bun and `restoreLeaves` only restores the
// driver / `password` leaves, so spread the real module rather than replacing it —
// and put it back in `afterAll` (the post-transaction-routes.test.ts pattern)
// so sibling files sharing the process exercise the real `sendAlarm`.
const realAlarm = { ...(await import("server/lib/alarm")) };

const mockSendAlarm = mock(async (_title: string, _detail: string, _key?: string) => undefined);
mock.module("server/lib/alarm", () => ({ ...realAlarm, sendAlarm: mockSendAlarm }));

const { deleteTransactionRoute } = await import("./accounts/delete-transaction");
const { deleteInvestmentTransactionRoute } = await import(
  "./accounts/delete-investment-transaction"
);
const { deleteAccountRoute } = await import("./accounts/delete-account");
const { deleteSnapshotRoute } = await import("./accounts/delete-snapshot");
const { deleteSplitTransactionRoute } = await import("./accounts/delete-split-transaction");
const { deleteBudgetRoute } = await import("./budgets/delete-budget");
const { deleteCategoryRoute } = await import("./budgets/delete-category");
const { deleteSectionRoute } = await import("./budgets/delete-section");
const { deleteChartRoute } = await import("./charts/delete-chart");

afterAll(() => {
  mock.module("server/lib/alarm", () => realAlarm);
  restoreLeaves();
});

beforeEach(() => {
  resetSqlMocks();
  mockSendAlarm.mockClear();
  txRows = [];
  invTxRows = [];
  accountRows = [];
  itemRows = [];
  sectionRows = [];
});

type Executor = {
  execute: (
    req: unknown,
    res: unknown,
  ) => Promise<{ status: string; message?: string; body?: unknown } | undefined>;
};

function makeReq(path: string, query: Record<string, unknown>, userId?: string): unknown {
  return {
    method: "DELETE",
    path,
    url: `http://x/api${path}`,
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
  };
}

const fakeRes = (): unknown =>
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
  }) as unknown;

const run = (
  route: Executor,
  path: string,
  query: Record<string, unknown>,
  userId: string | false = "u-1",
) => route.execute(makeReq(path, query, userId === false ? undefined : userId), fakeRes());

// The first call on `calls` whose SQL matches `re`, with its bound values.
const findCall = (
  calls: readonly unknown[][],
  re: RegExp,
): { sql: string; values: unknown[] } | null => {
  for (const call of calls) {
    const sql = call[0];
    if (typeof sql === "string" && re.test(sql)) {
      return { sql, values: (call[1] ?? []) as unknown[] };
    }
  }
  return null;
};

// A valid v4 UUID for the routes that validate `id` as one.
const UUID = "11111111-1111-4111-8111-111111111111";

// Row factories: full column sets, matching the proven shapes in
// transactions.test.ts (makeTxRow), post-holding-snapshot.success.test.ts
// (accountRow) and get-link-token.test.ts (itemRow). The models' typeChecker
// requires every column present (null is fine, undefined is not).
const transactionRow = (overrides: Record<string, unknown> = {}) => ({
  transaction_id: "tx-1",
  user_id: "u-1",
  account_id: "acc-1",
  name: "Coffee Shop",
  merchant_name: "Starbucks",
  amount: 5.5,
  iso_currency_code: "USD",
  date: "2026-03-01",
  pending: false,
  pending_transaction_id: null,
  payment_channel: "online",
  location_country: null,
  location_region: null,
  location_city: null,
  label_budget_id: null,
  label_category_id: null,
  label_memo: null,
  label_category_confidence: null,
  raw: null,
  updated: "2026-03-01T00:00:00Z",
  is_deleted: false,
  source: "manual",
  ...overrides,
});

const investmentTransactionRow = (overrides: Record<string, unknown> = {}) => ({
  investment_transaction_id: "itx-1",
  user_id: "u-1",
  account_id: "acc-1",
  security_id: "sec-1",
  date: "2026-03-01",
  name: "Buy VOO",
  amount: 1000,
  quantity: 10,
  price: 100,
  iso_currency_code: "USD",
  type: "buy",
  subtype: "purchase",
  label_budget_id: null,
  label_category_id: null,
  label_memo: null,
  raw: null,
  updated: "2026-03-01T00:00:00Z",
  is_deleted: false,
  source: "manual",
  ...overrides,
});

const accountRow = (overrides: Record<string, unknown> = {}) => ({
  account_id: "acc-1",
  user_id: "u-1",
  item_id: "item-1",
  institution_id: "ins-1",
  name: "Brokerage",
  type: "investment",
  subtype: null,
  balances_available: 0,
  balances_current: 0,
  balances_limit: 0,
  balances_iso_currency_code: "USD",
  custom_name: "",
  hide: false,
  archived: false,
  label_budget_id: null,
  graph_options_use_snapshots: false,
  graph_options_use_holding_snapshots: false,
  graph_options_use_transactions: false,
  raw: null,
  updated: null,
  is_deleted: false,
  ...overrides,
});

const itemRow = (overrides: Record<string, unknown> = {}) => ({
  item_id: "item-1",
  user_id: "u-1",
  access_token: "test-access-token",
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

describe("delete-transaction", () => {
  test("rejects unauthenticated requests before any SQL or alarm", async () => {
    const result = await run(deleteTransactionRoute, "/transaction", { id: "tx-1" }, false);
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/i);
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockSendAlarm).not.toHaveBeenCalled();
  });

  test("rejects a missing id before any SQL or alarm", async () => {
    const result = await run(deleteTransactionRoute, "/transaction", {});
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/Missing required parameter: id/);
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockSendAlarm).not.toHaveBeenCalled();
  });

  test("rejects a transaction the user does not own and deletes nothing", async () => {
    // The ownership lookup is user-scoped: no row comes back for a
    // transaction id the caller does not own.
    txRows = [];
    const result = await run(deleteTransactionRoute, "/transaction", { id: "tx-1" });
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/Transaction not found/);
    expect(findCall(mockUnsafe.mock.calls, /update\s+transactions\b/i)).toBeNull();
    expect(mockSendAlarm).not.toHaveBeenCalled();
  });

  test("rejects a synced transaction and deletes nothing", async () => {
    // The source gate is the security boundary: Plaid-synced rows are owned
    // by the sync path, and a manual delete would resurface on the next sync.
    txRows = [transactionRow({ source: "plaid" })];
    const result = await run(deleteTransactionRoute, "/transaction", { id: "tx-1" });
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/Only manual transactions can be deleted/);
    expect(findCall(mockUnsafe.mock.calls, /update\s+transactions\b/i)).toBeNull();
    expect(mockSendAlarm).not.toHaveBeenCalled();
  });

  test("deletes a manual transaction, user-scoped", async () => {
    txRows = [transactionRow()];
    const result = await run(deleteTransactionRoute, "/transaction", { id: "tx-1" });
    expect(result?.status).toBe("success");
    expect(result?.body).toEqual({ transaction_id: "tx-1" });
    // The soft-delete carries the caller's user_id and the id: the delete
    // cannot land on another user's row.
    const del = findCall(mockUnsafe.mock.calls, /update\s+transactions\b/i);
    expect(del).not.toBeNull();
    expect(del!.values).toContain("u-1");
    expect(del!.values).toContain("tx-1");
    // The split and pair cascades fire for the same id.
    expect(findCall(mockUnsafe.mock.calls, /update\s+split_transactions\b/i)).not.toBeNull();
    expect(findCall(mockUnsafe.mock.calls, /update\s+transaction_pairs\b/i)).not.toBeNull();
  });
});

describe("delete-investment-transaction", () => {
  test("rejects unauthenticated requests before any SQL or alarm", async () => {
    const result = await run(deleteInvestmentTransactionRoute, "/investment-transaction", { id: "itx-1" }, false);
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/i);
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockSendAlarm).not.toHaveBeenCalled();
  });

  test("rejects a missing id before any SQL or alarm", async () => {
    const result = await run(deleteInvestmentTransactionRoute, "/investment-transaction", {});
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/Missing required parameter: id/);
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockSendAlarm).not.toHaveBeenCalled();
  });

  test("rejects an investment transaction the user does not own and deletes nothing", async () => {
    invTxRows = [];
    const result = await run(deleteInvestmentTransactionRoute, "/investment-transaction", { id: "itx-1" });
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/Investment transaction not found/);
    expect(findCall(mockUnsafe.mock.calls, /update\s+investment_transactions\b/i)).toBeNull();
    expect(mockSendAlarm).not.toHaveBeenCalled();
  });

  test("rejects a synced investment transaction and deletes nothing", async () => {
    invTxRows = [investmentTransactionRow({ source: "plaid" })];
    const result = await run(deleteInvestmentTransactionRoute, "/investment-transaction", { id: "itx-1" });
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/Only manual investment transactions can be deleted/);
    expect(findCall(mockUnsafe.mock.calls, /update\s+investment_transactions\b/i)).toBeNull();
    expect(mockSendAlarm).not.toHaveBeenCalled();
  });

  test("deletes a manual investment transaction, user-scoped", async () => {
    invTxRows = [investmentTransactionRow()];
    const result = await run(deleteInvestmentTransactionRoute, "/investment-transaction", { id: "itx-1" });
    expect(result?.status).toBe("success");
    expect(result?.body).toEqual({ investment_transaction_id: "itx-1" });
    const del = findCall(mockUnsafe.mock.calls, /update\s+investment_transactions\b/i);
    expect(del).not.toBeNull();
    expect(del!.values).toContain("u-1");
    expect(del!.values).toContain("itx-1");
  });
});

describe("delete-account", () => {
  test("rejects unauthenticated requests before any SQL or alarm", async () => {
    const result = await run(deleteAccountRoute, "/account", { id: "acc-1" }, false);
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/i);
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockSendAlarm).not.toHaveBeenCalled();
  });

  test("rejects a missing id before any SQL or alarm", async () => {
    const result = await run(deleteAccountRoute, "/account", {});
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/Missing required parameter: id/);
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockSendAlarm).not.toHaveBeenCalled();
  });

  test("rejects an account the user does not own and deletes nothing", async () => {
    accountRows = [];
    const result = await run(deleteAccountRoute, "/account", { id: "acc-1" });
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/Account not found/);
    expect(mockReservedUnsafe).not.toHaveBeenCalled();
    expect(mockSendAlarm).not.toHaveBeenCalled();
  });

  test("rejects an account whose item is missing and deletes nothing", async () => {
    accountRows = [accountRow()];
    itemRows = [];
    const result = await run(deleteAccountRoute, "/account", { id: "acc-1" });
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/Item not found/);
    expect(mockReservedUnsafe).not.toHaveBeenCalled();
    expect(mockSendAlarm).not.toHaveBeenCalled();
  });

  test("rejects a non-manual account and deletes nothing", async () => {
    // The provider gate: only manual items are user-deletable — a Plaid
    // account's rows are sync-owned.
    accountRows = [accountRow()];
    itemRows = [itemRow({ provider: "plaid" })];
    const result = await run(deleteAccountRoute, "/account", { id: "acc-1" });
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/Account is not a manual account/);
    expect(mockReservedUnsafe).not.toHaveBeenCalled();
    expect(mockSendAlarm).not.toHaveBeenCalled();
  });

  test("deletes a manual account inside one transaction, user-scoped", async () => {
    accountRows = [accountRow()];
    itemRows = [itemRow({ provider: "manual" })];
    const result = await run(deleteAccountRoute, "/account", { id: "acc-1" });
    expect(result?.status).toBe("success");
    // The account soft-delete runs in the transaction and carries the
    // caller's user_id and the id.
    const del = findCall(mockReservedUnsafe.mock.calls, /update\s+accounts\b/i);
    expect(del).not.toBeNull();
    expect(del!.values).toContain("u-1");
    expect(del!.values).toContain("acc-1");
    // The cascade reaches the related tables in the same transaction.
    expect(findCall(mockReservedUnsafe.mock.calls, /update\s+transactions\b/i)).not.toBeNull();
    expect(findCall(mockReservedUnsafe.mock.calls, /update\s+snapshots\b/i)).not.toBeNull();
  });
});

describe("delete-snapshot", () => {
  test("rejects unauthenticated requests before any SQL or alarm", async () => {
    const result = await run(deleteSnapshotRoute, "/snapshot", { id: "snap-1" }, false);
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/i);
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockSendAlarm).not.toHaveBeenCalled();
  });

  test("rejects a missing id before any SQL or alarm", async () => {
    const result = await run(deleteSnapshotRoute, "/snapshot", {});
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/Missing required parameter: id/);
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockSendAlarm).not.toHaveBeenCalled();
  });

  test("soft-deletes the snapshot, user-scoped", async () => {
    // No ownership lookup lives in this route — the scoping is the repo's
    // softDelete, which binds the caller's user_id next to the id.
    const result = await run(deleteSnapshotRoute, "/snapshot", { id: "snap-1" });
    expect(result?.status).toBe("success");
    const del = findCall(mockUnsafe.mock.calls, /update\s+snapshots\b/i);
    expect(del).not.toBeNull();
    expect(del!.values).toContain("u-1");
    expect(del!.values).toContain("snap-1");
  });
});

describe("delete-split-transaction", () => {
  test("rejects unauthenticated requests before any SQL or alarm", async () => {
    const result = await run(deleteSplitTransactionRoute, "/split-transaction", { id: UUID }, false);
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/i);
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockSendAlarm).not.toHaveBeenCalled();
  });

  test("rejects a missing id before any SQL or alarm", async () => {
    const result = await run(deleteSplitTransactionRoute, "/split-transaction", {});
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/Missing required parameter: id/);
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockSendAlarm).not.toHaveBeenCalled();
  });

  test("rejects a malformed id before any SQL or alarm", async () => {
    // `id` becomes a UUID-column predicate below: a malformed value is a
    // failed answer, not a 22P02 inside Route.execute.
    const result = await run(deleteSplitTransactionRoute, "/split-transaction", { id: "not-a-uuid" });
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/Field id must be a uuid/);
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockSendAlarm).not.toHaveBeenCalled();
  });

  test("soft-deletes the split transaction, user-scoped", async () => {
    const result = await run(deleteSplitTransactionRoute, "/split-transaction", { id: UUID });
    expect(result?.status).toBe("success");
    const del = findCall(mockUnsafe.mock.calls, /update\s+split_transactions\b/i);
    expect(del).not.toBeNull();
    expect(del!.values).toContain("u-1");
    expect(del!.values).toContain(UUID);
  });
});

describe("delete-budget / delete-category / delete-section", () => {
  test("rejects unauthenticated requests before any SQL or alarm", async () => {
    for (const [route, path] of [
      [deleteBudgetRoute, "/budget"],
      [deleteCategoryRoute, "/category"],
      [deleteSectionRoute, "/section"],
    ] as const) {
      mockUnsafe.mockClear();
      mockSendAlarm.mockClear();
      const result = await run(route, path, { id: UUID }, false);
      expect(result?.status).toBe("failed");
      expect(result?.message).toMatch(/not authenticated/i);
      expect(mockUnsafe).not.toHaveBeenCalled();
      expect(mockSendAlarm).not.toHaveBeenCalled();
    }
  });

  test("rejects a missing id before any SQL or alarm", async () => {
    for (const [route, path] of [
      [deleteBudgetRoute, "/budget"],
      [deleteCategoryRoute, "/category"],
      [deleteSectionRoute, "/section"],
    ] as const) {
      mockUnsafe.mockClear();
      mockSendAlarm.mockClear();
      const result = await run(route, path, {});
      expect(result?.status).toBe("failed");
      expect(result?.message).toMatch(/Missing required parameter: id/);
      expect(mockUnsafe).not.toHaveBeenCalled();
      expect(mockSendAlarm).not.toHaveBeenCalled();
    }
  });

  test("rejects a malformed id before any SQL or alarm", async () => {
    for (const [route, path] of [
      [deleteBudgetRoute, "/budget"],
      [deleteCategoryRoute, "/category"],
      [deleteSectionRoute, "/section"],
    ] as const) {
      mockUnsafe.mockClear();
      mockSendAlarm.mockClear();
      const result = await run(route, path, { id: "not-a-uuid" });
      expect(result?.status).toBe("failed");
      expect(result?.message).toMatch(/Field id must be a uuid/);
      expect(mockUnsafe).not.toHaveBeenCalled();
      expect(mockSendAlarm).not.toHaveBeenCalled();
    }
  });

  test("delete-budget looks up sections user-scoped, then soft-deletes in a transaction", async () => {
    sectionRows = [];
    const result = await run(deleteBudgetRoute, "/budget", { id: UUID });
    expect(result?.status).toBe("success");
    // The sections lookup carries the caller's user_id and the budget id.
    const lookup = findCall(mockUnsafe.mock.calls, /select[\s\S]*from\s+sections\b/i);
    expect(lookup).not.toBeNull();
    expect(lookup!.values).toContain("u-1");
    expect(lookup!.values).toContain(UUID);
    // The budget soft-delete runs in the transaction, user-scoped.
    const del = findCall(mockReservedUnsafe.mock.calls, /update\s+budgets\b/i);
    expect(del).not.toBeNull();
    expect(del!.values).toContain("u-1");
    expect(del!.values).toContain(UUID);
  });

  test("delete-category soft-deletes the category, user-scoped", async () => {
    const result = await run(deleteCategoryRoute, "/category", { id: UUID });
    expect(result?.status).toBe("success");
    const del = findCall(mockUnsafe.mock.calls, /update\s+categories\b/i);
    expect(del).not.toBeNull();
    expect(del!.values).toContain("u-1");
    expect(del!.values).toContain(UUID);
  });

  test("delete-section cascades to its categories in the same transaction", async () => {
    const result = await run(deleteSectionRoute, "/section", { id: UUID });
    expect(result?.status).toBe("success");
    // Categories under the section go first, then the section itself — both
    // in the transaction, both user-scoped.
    const catDel = findCall(mockReservedUnsafe.mock.calls, /update\s+categories\b/i);
    expect(catDel).not.toBeNull();
    expect(catDel!.values).toContain("u-1");
    expect(catDel!.values).toContain(UUID);
    const secDel = findCall(mockReservedUnsafe.mock.calls, /update\s+sections\b/i);
    expect(secDel).not.toBeNull();
    expect(secDel!.values).toContain("u-1");
    expect(secDel!.values).toContain(UUID);
  });
});

describe("delete-chart", () => {
  test("rejects unauthenticated requests before any SQL or alarm", async () => {
    const result = await run(deleteChartRoute, "/chart", { id: UUID }, false);
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/i);
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockSendAlarm).not.toHaveBeenCalled();
  });

  test("rejects a missing id before any SQL or alarm", async () => {
    const result = await run(deleteChartRoute, "/chart", {});
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/Missing required parameter: id/);
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockSendAlarm).not.toHaveBeenCalled();
  });

  test("rejects a malformed id before any SQL or alarm", async () => {
    const result = await run(deleteChartRoute, "/chart", { id: "not-a-uuid" });
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/Field id must be a uuid/);
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockSendAlarm).not.toHaveBeenCalled();
  });

  test("soft-deletes the chart, user-scoped", async () => {
    const result = await run(deleteChartRoute, "/chart", { id: UUID });
    expect(result?.status).toBe("success");
    const del = findCall(mockUnsafe.mock.calls, /update\s+charts\b/i);
    expect(del).not.toBeNull();
    expect(del!.values).toContain("u-1");
    expect(del!.values).toContain(UUID);
  });
});
