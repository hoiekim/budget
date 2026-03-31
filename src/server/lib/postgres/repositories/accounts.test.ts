/**
 * Unit tests for accounts repository
 * Tests getAccounts, getAccount, searchAccounts, searchAccountsById,
 * upsertAccounts using pool.query mocks.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { AccountType, AccountSubtype } from "plaid";

// ---------------------------------------------------------------------------
// Mock pool BEFORE imports
// ---------------------------------------------------------------------------

const mockQuery = mock(
  (_sql: string, _values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }> =>
    Promise.resolve({ rows: [], rowCount: 0 }),
);

mock.module("../client", () => ({
  pool: { query: mockQuery },
  withTransaction: async (fn: (client: unknown) => Promise<unknown>) => {
    const fakeClient = { query: mockQuery };
    return fn(fakeClient);
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import {
  getAccounts,
  getAccount,
  searchAccounts,
  searchAccountsById,
  upsertAccounts,
} from "./accounts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  mockQuery.mockReset();
});

// ---------------------------------------------------------------------------
// getAccounts
// ---------------------------------------------------------------------------

describe("getAccounts", () => {
  test("returns empty array when no accounts", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await getAccounts(testUser);
    expect(result).toEqual([]);
  });

  test("returns mapped JSONAccount array", async () => {
    const row = makeAccountRow();
    mockQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });

    const result = await getAccounts(testUser);
    expect(result).toHaveLength(1);
    expect(result[0].account_id).toBe("acc-1");
    expect(result[0].name).toBe("Checking");
    expect(result[0].type).toBe(AccountType.Depository);
  });

  test("balances are nested correctly", async () => {
    const row = makeAccountRow({
      balances_available: 500,
      balances_current: 600,
      balances_limit: null,
      balances_iso_currency_code: "EUR",
    });
    mockQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });

    const result = await getAccounts(testUser);
    expect(result[0].balances.available).toBe(500);
    expect(result[0].balances.current).toBe(600);
    expect(result[0].balances.limit).toBeNull();
    expect(result[0].balances.iso_currency_code).toBe("EUR");
  });

  test("passes user_id filter to query", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await getAccounts({ user_id: "usr-99", username: "test" });

    const values = mockQuery.mock.calls[0][1] as string[];
    expect(values).toContain("usr-99");
  });

  test("returns multiple accounts", async () => {
    const rows = [
      makeAccountRow({ account_id: "acc-1", name: "Checking" }),
      makeAccountRow({ account_id: "acc-2", name: "Savings" }),
    ];
    mockQuery.mockResolvedValueOnce({ rows, rowCount: 2 });

    const result = await getAccounts(testUser);
    expect(result).toHaveLength(2);
    expect(result.map((a) => a.account_id)).toEqual(["acc-1", "acc-2"]);
  });
});

// ---------------------------------------------------------------------------
// getAccount
// ---------------------------------------------------------------------------

describe("getAccount", () => {
  test("returns account when found", async () => {
    const row = makeAccountRow({ account_id: "acc-specific" });
    mockQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });

    const result = await getAccount(testUser, "acc-specific");
    expect(result).not.toBeNull();
    expect(result?.account_id).toBe("acc-specific");
  });

  test("returns null when not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await getAccount(testUser, "nonexistent");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// searchAccounts
// ---------------------------------------------------------------------------

describe("searchAccounts", () => {
  test("returns all accounts with no options", async () => {
    const rows = [makeAccountRow()];
    mockQuery.mockResolvedValueOnce({ rows, rowCount: 1 });

    const result = await searchAccounts(testUser);
    expect(result).toHaveLength(1);
  });

  test("filters by account_id when provided", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await searchAccounts(testUser, { account_id: "acc-filter" });

    const values = mockQuery.mock.calls[0][1] as string[];
    expect(values).toContain("acc-filter");
  });

  test("filters by item_id when provided", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await searchAccounts(testUser, { item_id: "item-filter" });

    const values = mockQuery.mock.calls[0][1] as string[];
    expect(values).toContain("item-filter");
  });

  test("filters by type when provided", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await searchAccounts(testUser, { type: AccountType.Investment });

    const values = mockQuery.mock.calls[0][1] as string[];
    expect(values).toContain(AccountType.Investment);
  });
});

// ---------------------------------------------------------------------------
// searchAccountsById
// ---------------------------------------------------------------------------

describe("searchAccountsById", () => {
  test("returns empty array for empty ids", async () => {
    const result = await searchAccountsById(testUser, []);
    expect(result).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("returns accounts for given ids", async () => {
    const rows = [makeAccountRow({ account_id: "acc-a" })];
    mockQuery.mockResolvedValueOnce({ rows, rowCount: 1 });

    const result = await searchAccountsById(testUser, ["acc-a"]);
    expect(result).toHaveLength(1);
    expect(result[0].account_id).toBe("acc-a");
  });

  test("queries all provided ids", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await searchAccountsById(testUser, ["id-1", "id-2", "id-3"]);

    const sql = mockQuery.mock.calls[0][0] as string;
    const values = mockQuery.mock.calls[0][1] as string[];
    // Should use IN clause with 3 placeholders
    expect(sql).toContain("IN");
    expect(values.slice(0, 3)).toEqual(["id-1", "id-2", "id-3"]);
  });
});

// ---------------------------------------------------------------------------
// upsertAccounts
// ---------------------------------------------------------------------------

describe("upsertAccounts", () => {
  test("returns empty array for empty input", async () => {
    const result = await upsertAccounts(testUser, []);
    expect(result).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("returns success result per account", async () => {
    mockQuery.mockResolvedValue({ rows: [{ account_id: "acc-1" }], rowCount: 1 });

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
    mockQuery.mockRejectedValueOnce(new Error("DB unavailable"));

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
    mockQuery.mockResolvedValue({ rows: [{ account_id: "acc-n" }], rowCount: 1 });

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
    expect(result.every((r) => r.status === 200)).toBe(true);
  });
});
