import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakePg, restoreLeaves } from "test-helpers";
import type { QueryExecutor } from "../models";
import { AccountType, AccountSubtype } from "plaid";

const { pg, mockQuery, mockClientQuery, resetQueryMocks } = createFakePg();

mock.module("pg", () => pg);

const { deleteItem, upsertItems } = await import("./items");

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
    resetQueryMocks();
  });

  test("soft-deletes snapshots by BOTH account_id and holding_account_id", async () => {
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
    const snapshotDeletes = mockClientQuery.mock.calls
      .map(([sql]) => sql)
      .filter(
        (sql): sql is string =>
          typeof sql === "string" && /UPDATE\s+snapshots\b/i.test(sql) && /is_deleted/i.test(sql),
      );

    expect(snapshotDeletes.some((sql) => /WHERE\s+account_id\s*=/i.test(sql))).toBe(true);
    expect(snapshotDeletes.some((sql) => /WHERE\s+holding_account_id\s*=/i.test(sql))).toBe(true);
  });

  test("cascades to transaction_pairs on BOTH join columns, scoped to the user", async () => {
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

    const pairDeletes = mockClientQuery.mock.calls.filter(
      ([sql]) =>
        typeof sql === "string" &&
        /UPDATE\s+transaction_pairs\b/i.test(sql) &&
        /is_deleted/i.test(sql),
    );

    // A pair joins `transactions` by id while this cascade only knows account
    // ids, so each column resolves through a subquery rather than an id array.
    const byColumn = (column: string) =>
      pairDeletes.find(
        ([sql]) =>
          typeof sql === "string" &&
          new RegExp(`WHERE\\s+${column}\\s+IN\\s*\\(SELECT`, "i").test(sql),
      );

    const pairA = byColumn("transaction_id_a");
    const pairB = byColumn("transaction_id_b");
    expect(pairA).toBeDefined();
    expect(pairB).toBeDefined();

    // On the pool the cascade commits on its own: a later failure in this
    // block rolls the accounts back and leaves their pairs soft-deleted.
    expect(
      mockQuery.mock.calls.some(
        ([sql]) => typeof sql === "string" && /UPDATE\s+transaction_pairs\b/i.test(sql),
      ),
    ).toBe(false);

    for (const call of [pairA, pairB]) {
      const [sql, values] = call as [string, unknown[]];
      // The subquery selects transaction ids for the item's accounts, and it
      // must NOT exclude soft-deleted rows: the transactions this cascade
      // travels through were soft-deleted earlier in the same transaction.
      expect(sql).toMatch(/SELECT\s+transaction_id\s+FROM\s+transactions\s+WHERE\s+account_id\s*=\s*ANY\(\$1\)\)/i);
      expect(sql).not.toMatch(/is_deleted\s*=\s*FALSE/i);
      // Scoped to the owner — a pair is never reachable across users.
      expect(sql).toMatch(/AND\s+user_id\s*=\s*\$2/i);
      // The `updated` bump is what lets a delta sync deliver the tombstone;
      // without it the client keeps the stale pair until a cold load.
      expect(sql).toMatch(/SET\s+is_deleted\s*=\s*TRUE,\s*updated\s*=\s*CURRENT_TIMESTAMP/i);
      expect(values).toEqual([["acc-del"], "usr-1"]);
    }
  });

  test("runs the pairs cascade AFTER the transactions soft-delete", async () => {
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

    const sqls = mockClientQuery.mock.calls
      .map(([sql]) => sql)
      .filter((sql): sql is string => typeof sql === "string");
    const transactionsDelete = sqls.findIndex(
      (sql) => /UPDATE\s+transactions\b/i.test(sql) && /is_deleted/i.test(sql),
    );
    const firstPairDelete = sqls.findIndex((sql) => /UPDATE\s+transaction_pairs\b/i.test(sql));

    expect(transactionsDelete).toBeGreaterThanOrEqual(0);
    expect(firstPairDelete).toBeGreaterThanOrEqual(0);
    // The transactions UPDATE holds an exclusive row lock until commit, which
    // is what stops a concurrent pairTransactions (FOR SHARE existence check)
    // from minting a pair behind this cascade. Reversed, that pair survives on
    // soft-deleted transactions.
    expect(transactionsDelete).toBeLessThan(firstPairDelete);
  });

  test("issues every write on the transaction client, never on the pool", async () => {
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

    // The account lookup is the only statement outside `withTransaction`.
    const poolWrites = mockQuery.mock.calls
      .map(([sql]) => sql)
      .filter((sql): sql is string => typeof sql === "string")
      .filter((sql) => /^\s*(UPDATE|INSERT|DELETE)\b/i.test(sql));
    expect(poolWrites).toEqual([]);

    const clientUpdates = mockClientQuery.mock.calls
      .map(([sql]) => sql)
      .filter((sql): sql is string => typeof sql === "string")
      .map((sql) => sql.match(/^\s*UPDATE\s+(\w+)/i)?.[1])
      .filter((table): table is string => !!table);
    expect(clientUpdates).toContain("transaction_pairs");
    expect(clientUpdates).toContain("transactions");
    expect(clientUpdates).toContain("snapshots");
    expect(clientUpdates).toContain("accounts");
    expect(clientUpdates).toContain("items");
  });

  test("skips the transaction_pairs cascade when the item owns no accounts", async () => {
    mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));

    await deleteItem(testUser, "item-empty");

    const pairDeletes = mockClientQuery.mock.calls.filter(
      ([sql]) => typeof sql === "string" && /UPDATE\s+transaction_pairs\b/i.test(sql),
    );
    expect(pairDeletes).toHaveLength(0);
  });
});

describe("upsertItems", () => {
  beforeEach(() => {
    resetQueryMocks();
    mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 1 }));
  });

  test("writes through the executor it is handed, leaving the pool untouched", async () => {
    const clientQuery = mock(async () => ({ rows: [], rowCount: 1 }));

    await upsertItems(testUser, [{ item_id: "item-1" }], {
      query: clientQuery,
    } as unknown as QueryExecutor);

    expect(clientQuery.mock.calls).toHaveLength(1);
    expect(mockQuery.mock.calls).toHaveLength(0);
  });

  test("the write is an upsert — an id the caller supplied never keys a bare UPDATE", async () => {
    await upsertItems(testUser, [{ item_id: "item-1" }]);

    const sqls = mockQuery.mock.calls.map(([sql]) => String(sql));
    expect(sqls.filter((sql) => /ON CONFLICT/i.test(sql))).toHaveLength(1);
    expect(sqls.filter((sql) => /^\s*UPDATE\s/i.test(sql))).toHaveLength(0);
  });
});
