import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";
import { AccountType, AccountSubtype } from "plaid";

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

const { deleteItem } = await import("./items");

afterAll(restoreLeaves);

function makeAccountRow(overrides: Record<string, unknown> = {}) {
  return {
    account_id: "acc-1",
    user_id: "usr-1",
    item_id: "item-1",
    institution_id: "ins-1",
    name: "Brokerage",
    type: AccountType.Investment,
    subtype: AccountSubtype.Brokerage,
    balances_available: 1000,
    balances_current: 1050,
    balances_limit: null,
    balances_iso_currency_code: "USD",
    custom_name: null,
    hide: false,
    archived: false,
    label_budget_id: null,
    graph_options_use_snapshots: false,
    graph_options_use_holding_snapshots: false,
    graph_options_use_transactions: false,
    raw: null,
    is_deleted: false,
    updated: "2026-03-01T00:00:00Z",
    ...overrides,
  };
}

const testUser = { user_id: "usr-1", username: "hoie" };

describe("deleteItem", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  test("soft-deletes snapshots by BOTH account_id and holding_account_id (#539)", async () => {
    // The initial account lookup must return an account so the per-account
    // cascade runs; every other query (the soft-deletes, BEGIN/COMMIT) returns
    // empty.
    mockQuery.mockImplementation(async (sql: string) => {
      if (/SELECT/i.test(sql) && /\baccounts\b/i.test(sql)) {
        return {
          rows: [makeAccountRow({ account_id: "acc-del", item_id: "item-del" })],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    await deleteItem(testUser, "item-del");

    // Account-balance snapshots live under `account_id`; holding snapshots live
    // under `holding_account_id` (their `account_id` is NULL). Both passes must
    // fire or the item-delete path orphans the holding-snapshot history — the
    // bug PR 475 fixed for deleteAccounts but never propagated here.
    const snapshotDeletes = mockQuery.mock.calls
      .map(([sql]) => sql)
      .filter(
        (sql): sql is string =>
          typeof sql === "string" && /UPDATE\s+snapshots\b/i.test(sql) && /is_deleted/i.test(sql),
      );

    expect(snapshotDeletes.some((sql) => /WHERE\s+account_id\s*=/i.test(sql))).toBe(true);
    expect(snapshotDeletes.some((sql) => /WHERE\s+holding_account_id\s*=/i.test(sql))).toBe(true);
  });
});
