import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";
import { AccountType, AccountSubtype } from "plaid";

const { driver, mockUnsafe, mockReservedUnsafe, resetSqlMocks } = createFakeSql();

mock.module("../sql-driver", () => driver);

const {
  getAccounts,
  getAccount,
  searchAccounts,
  searchAccountsById,
  createManualAccount,
  upsertAccounts,
  deleteAccounts,
} = await import("./accounts");

afterAll(restoreLeaves);

function makeAccountRow(overrides: Record<string, unknown> = {}) {
  return {
    account_id: "acc-1",
    user_id: "usr-1",
    item_id: "item-1",
    institution_id: "ins-1",
    name: "Checking",
    type: AccountType.Depository,
    subtype: AccountSubtype.Checking,
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

beforeEach(() => {
  resetSqlMocks();
});

describe("getAccounts", () => {
  test("returns empty array when no accounts", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await getAccounts(testUser);
    expect(result).toEqual([]);
  });

  test("returns mapped JSONAccount array", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [makeAccountRow()], rowCount: 1 });
    const result = await getAccounts(testUser);
    expect(result).toHaveLength(1);
    expect(result[0].account_id).toBe("acc-1");
    expect(result[0].name).toBe("Checking");
    expect(result[0].type).toBe(AccountType.Depository);
  });

  test("balances are nested correctly", async () => {
    mockUnsafe.mockResolvedValueOnce({
      rows: [
        makeAccountRow({
          balances_available: 500,
          balances_current: 600,
          balances_limit: null,
          balances_iso_currency_code: "EUR",
        }),
      ],
      rowCount: 1,
    });
    const result = await getAccounts(testUser);
    expect(result[0].balances.available).toBe(500);
    expect(result[0].balances.current).toBe(600);
    expect(result[0].balances.limit).toBeNull();
    expect(result[0].balances.iso_currency_code).toBe("EUR");
  });

  test("passes user_id filter to query", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await getAccounts({ user_id: "usr-99", username: "test" });
    const values = mockUnsafe.mock.calls[0][1] as string[];
    expect(values).toContain("usr-99");
  });

  test("returns multiple accounts", async () => {
    mockUnsafe.mockResolvedValueOnce({
      rows: [
        makeAccountRow({ account_id: "acc-1", name: "Checking" }),
        makeAccountRow({ account_id: "acc-2", name: "Savings" }),
      ],
      rowCount: 2,
    });
    const result = await getAccounts(testUser);
    expect(result).toHaveLength(2);
    expect(result.map((a: { account_id: string }) => a.account_id)).toEqual(["acc-1", "acc-2"]);
  });
});

describe("getAccount", () => {
  test("returns account when found", async () => {
    mockUnsafe.mockResolvedValueOnce({
      rows: [makeAccountRow({ account_id: "acc-specific" })],
      rowCount: 1,
    });
    const result = await getAccount(testUser, "acc-specific");
    expect(result).not.toBeNull();
    expect(result?.account_id).toBe("acc-specific");
  });

  test("returns null when not found", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await getAccount(testUser, "nonexistent");
    expect(result).toBeNull();
  });
});

describe("searchAccounts", () => {
  test("returns all accounts with no options", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [makeAccountRow()], rowCount: 1 });
    const result = await searchAccounts(testUser);
    expect(result).toHaveLength(1);
  });

  test("filters by account_id when provided", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await searchAccounts(testUser, { account_id: "acc-filter" });
    const values = mockUnsafe.mock.calls[0][1] as string[];
    expect(values).toContain("acc-filter");
  });

  test("filters by item_id when provided", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await searchAccounts(testUser, { item_id: "item-filter" });
    const values = mockUnsafe.mock.calls[0][1] as string[];
    expect(values).toContain("item-filter");
  });

  test("filters by type when provided", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await searchAccounts(testUser, { type: AccountType.Investment });
    const values = mockUnsafe.mock.calls[0][1] as string[];
    expect(values).toContain(AccountType.Investment);
  });
});

describe("searchAccountsById", () => {
  test("returns empty array for empty ids", async () => {
    const result = await searchAccountsById(testUser, []);
    expect(result).toEqual([]);
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("returns accounts for given ids", async () => {
    mockUnsafe.mockResolvedValueOnce({
      rows: [makeAccountRow({ account_id: "acc-a" })],
      rowCount: 1,
    });
    const result = await searchAccountsById(testUser, ["acc-a"]);
    expect(result).toHaveLength(1);
    expect(result[0].account_id).toBe("acc-a");
  });

  test("queries all provided ids", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await searchAccountsById(testUser, ["id-1", "id-2", "id-3"]);
    const sql = mockUnsafe.mock.calls[0][0] as string;
    const values = mockUnsafe.mock.calls[0][1] as string[];
    expect(sql).toContain("IN");
    expect(values.slice(0, 3)).toEqual(["id-1", "id-2", "id-3"]);
  });
});

describe("upsertAccounts", () => {
  test("returns empty array for empty input", async () => {
    const result = await upsertAccounts(testUser, []);
    expect(result).toEqual([]);
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("returns success result per account", async () => {
    mockUnsafe.mockResolvedValue({ rows: [{ account_id: "acc-1" }], rowCount: 1 });
    const account = {
      account_id: "acc-1",
      item_id: "item-1",
      name: "Test Account",
      type: AccountType.Depository,
      balances: { available: 100, current: 100, limit: null, iso_currency_code: "USD" },
    } as Parameters<typeof upsertAccounts>[1][0];
    const result = await upsertAccounts(testUser, [account]);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe(200);
    expect(result[0].update._id).toBe("acc-1");
  });

  test("returns error result on query failure", async () => {
    mockUnsafe.mockRejectedValueOnce(new Error("DB unavailable"));
    const account = {
      account_id: "acc-err",
      item_id: "item-1",
      name: "Failing Account",
      type: AccountType.Depository,
      balances: { available: 0, current: 0, limit: null, iso_currency_code: "USD" },
    } as Parameters<typeof upsertAccounts>[1][0];
    const result = await upsertAccounts(testUser, [account]);
    expect(result[0].status).toBe(500);
    expect(result[0].update._id).toBe("acc-err");
  });

  test("handles multiple accounts in batch", async () => {
    mockUnsafe.mockResolvedValue({ rows: [{ account_id: "acc-n" }], rowCount: 1 });
    const accounts = ["acc-1", "acc-2", "acc-3"].map(
      (id) =>
        ({
          account_id: id,
          item_id: "item-1",
          name: id,
          type: AccountType.Depository,
          balances: { available: 0, current: 0, limit: null, iso_currency_code: "USD" },
        }) as Parameters<typeof upsertAccounts>[1][0],
    );
    const result = await upsertAccounts(testUser, accounts);
    expect(result).toHaveLength(3);
    expect(result.every((r: { status: number }) => r.status === 200)).toBe(true);
  });
});

describe("createManualAccount", () => {
  test("issues an INSERT into accounts, no ON CONFLICT clause", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [makeAccountRow({ account_id: "manual-abc" })], rowCount: 1 });
    await createManualAccount(testUser, { item_id: "item-1" });
    const sql = mockUnsafe.mock.calls[0][0] as string;
    expect(sql).toMatch(/^\s*INSERT\s+INTO\s+accounts\b/i);
    expect(sql).not.toMatch(/ON\s+CONFLICT/i);
  });

  test("binds the requesting user's id and the item_id", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [makeAccountRow()], rowCount: 1 });
    await createManualAccount({ user_id: "usr-99", username: "other" }, { item_id: "item-x" });
    const values = mockUnsafe.mock.calls[0][1] as unknown[];
    expect(values).toContain("usr-99");
    expect(values).toContain("item-x");
  });

  test("server-generates a `manual-<uuid>` account_id — the FE never supplies one", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [makeAccountRow()], rowCount: 1 });
    await createManualAccount(testUser, { item_id: "item-1" });
    const values = mockUnsafe.mock.calls[0][1] as unknown[];
    const minted = values.find((v) => typeof v === "string" && /^manual-/.test(v as string));
    expect(minted).toBeDefined();
  });

  test("defaults institution_id to \"Unknown\" — the sentinel `sync.ts` recognises", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [makeAccountRow()], rowCount: 1 });
    await createManualAccount(testUser, { item_id: "item-1" });
    const values = mockUnsafe.mock.calls[0][1] as unknown[];
    expect(values).toContain("Unknown");
  });

  test("returns the created JSONAccount when a row comes back", async () => {
    mockUnsafe.mockResolvedValueOnce({
      rows: [makeAccountRow({ account_id: "manual-abc", name: "Unknown" })],
      rowCount: 1,
    });
    const result = await createManualAccount(testUser, { item_id: "item-1" });
    expect(result).not.toBeNull();
    expect(result?.account_id).toBe("manual-abc");
    expect(result?.name).toBe("Unknown");
  });

  test("returns null when the insert returns no row", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await createManualAccount(testUser, { item_id: "item-1" });
    expect(result).toBeNull();
  });

  test("returns null when the insert throws — logged, not raised", async () => {
    mockUnsafe.mockRejectedValueOnce(new Error("DB unavailable"));
    const result = await createManualAccount(testUser, { item_id: "item-1" });
    expect(result).toBeNull();
  });

  test("does not write the `raw` column — it exists for a provider's payload, and a manual account has none", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [makeAccountRow()], rowCount: 1 });
    await createManualAccount(testUser, { item_id: "item-1" });
    const sql = mockUnsafe.mock.calls[0][0] as string;
    expect(sql).not.toMatch(/\braw\b/);
  });
});

describe("deleteAccounts", () => {
  test("returns deleted: 0 without querying for empty input", async () => {
    const result = await deleteAccounts(testUser, []);
    expect(result).toEqual({ deleted: 0 });
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockReservedUnsafe).not.toHaveBeenCalled();
  });

  test("soft-deletes snapshots by BOTH account_id and holding_account_id", async () => {
    mockReservedUnsafe.mockResolvedValue({ rows: [], rowCount: 0 });
    await deleteAccounts(testUser, ["acc-del"]);

    // Account-balance snapshots live under `account_id`; holding snapshots
    // live under `holding_account_id` (their `account_id` is NULL). Both
    // passes must fire or the holding-snapshot history is orphaned.
    const snapshotDeletes = mockReservedUnsafe.mock.calls
      .map(([sql]) => sql)
      .filter(
        (sql): sql is string =>
          typeof sql === "string" && /UPDATE\s+snapshots\b/i.test(sql) && /is_deleted/i.test(sql),
      );

    expect(snapshotDeletes.some((sql) => /WHERE\s+account_id\s*=/i.test(sql))).toBe(true);
    expect(snapshotDeletes.some((sql) => /WHERE\s+holding_account_id\s*=/i.test(sql))).toBe(true);
  });

  test("cascades to transaction_pairs on both join columns, once for all accounts", async () => {
    mockReservedUnsafe.mockResolvedValue({ rows: [], rowCount: 0 });
    await deleteAccounts(testUser, ["acc-a", "acc-b"]);

    const pairDeletes = mockReservedUnsafe.mock.calls.filter(
      ([sql]) => typeof sql === "string" && /UPDATE\s+transaction_pairs\b/i.test(sql),
    );

    // Hoisted out of the per-account loop: two statements total, not two per
    // account, with every account id in one `= ANY($1)`.
    expect(pairDeletes).toHaveLength(2);
    for (const [sql, values] of pairDeletes as [string, unknown[]][]) {
      expect(sql).toMatch(
        /SELECT\s+transaction_id\s+FROM\s+transactions\s+WHERE\s+account_id\s*=\s*ANY\(\$1\)\)/i,
      );
      expect(sql).toMatch(/AND\s+user_id\s*=\s*\$2/i);
      // The `updated` bump is what lets a delta sync deliver the tombstone;
      // without it the client keeps the stale pair until a cold load.
      expect(sql).toMatch(/SET\s+is_deleted\s*=\s*TRUE,\s*updated\s*=\s*CURRENT_TIMESTAMP/i);
      expect(values).toEqual([["acc-a", "acc-b"], "usr-1"]);
    }
    expect(
      pairDeletes.some(([sql]) => /WHERE\s+transaction_id_a\s+IN\s*\(SELECT/i.test(sql as string)),
    ).toBe(true);
    expect(
      pairDeletes.some(([sql]) => /WHERE\s+transaction_id_b\s+IN\s*\(SELECT/i.test(sql as string)),
    ).toBe(true);

    // On the pool the cascade commits on its own, so the `bulkSoftDelete` that
    // follows can fail and roll the accounts back while their pairs stay
    // soft-deleted. It also drops the row-lock serialization the cascade's
    // ordering against a concurrent pairTransactions depends on.
    expect(
      mockUnsafe.mock.calls.some(
        ([sql]) => typeof sql === "string" && /UPDATE\s+transaction_pairs\b/i.test(sql),
      ),
    ).toBe(false);
  });

  test("issues every write on the transaction client, never on the pool", async () => {
    await deleteAccounts(testUser, ["acc-del"]);

    // `deleteAccounts` opens with `withTransaction` and reads nothing first,
    // so the pool must stay untouched for the whole call.
    expect(mockUnsafe).not.toHaveBeenCalled();

    const clientUpdates = mockReservedUnsafe.mock.calls
      .map(([sql]) => sql)
      .filter((sql): sql is string => typeof sql === "string")
      .map((sql) => sql.match(/^\s*UPDATE\s+(\w+)/i)?.[1])
      .filter((table): table is string => !!table);
    expect(clientUpdates).toContain("transaction_pairs");
    expect(clientUpdates).toContain("transactions");
    expect(clientUpdates).toContain("snapshots");
    expect(clientUpdates).toContain("accounts");
  });

  test("runs the pairs cascade AFTER the transactions soft-delete", async () => {
    mockReservedUnsafe.mockResolvedValue({ rows: [], rowCount: 0 });
    await deleteAccounts(testUser, ["acc-del"]);

    const sqls = mockReservedUnsafe.mock.calls
      .map(([sql]) => sql)
      .filter((sql): sql is string => typeof sql === "string");
    const transactionsDelete = sqls.findIndex(
      (sql) => /UPDATE\s+transactions\b/i.test(sql) && /is_deleted/i.test(sql),
    );
    const firstPairDelete = sqls.findIndex((sql) => /UPDATE\s+transaction_pairs\b/i.test(sql));

    expect(transactionsDelete).toBeGreaterThanOrEqual(0);
    expect(firstPairDelete).toBeGreaterThanOrEqual(0);
    expect(transactionsDelete).toBeLessThan(firstPairDelete);
  });
});
