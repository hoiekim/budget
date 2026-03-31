/**
 * Unit tests for transactions repository
 * Tests getTransactions, getTransaction, searchTransactionsById,
 * upsertTransactions, updateTransactions, getOldestTransactionDate
 * using pool.query mocks.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// Mock pool and withTransaction BEFORE imports
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
  getTransactions,
  getTransaction,
  searchTransactionsById,
  upsertTransactions,
  getOldestTransactionDate,
} from "./transactions";
import { TransactionPaymentChannelEnum } from "plaid";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTxRow(overrides: Record<string, unknown> = {}) {
  return {
    transaction_id: "tx-1",
    user_id: "usr-1",
    account_id: "acc-1",
    name: "Coffee Shop",
    merchant_name: "Starbucks",
    amount: 5.5,
    iso_currency_code: "USD",
    date: "2026-03-01",
    pending: false,
    pending_transaction_id: null,
    payment_channel: TransactionPaymentChannelEnum.InStore,
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
    transfer_pair_id: null,
    transfer_status: null,
    ...overrides,
  };
}

const testUser = { user_id: "usr-1", username: "hoie" };

beforeEach(() => {
  mockQuery.mockReset();
});

// ---------------------------------------------------------------------------
// getTransactions
// ---------------------------------------------------------------------------

describe("getTransactions", () => {
  test("returns empty array when no transactions", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await getTransactions(testUser);
    expect(result).toEqual([]);
  });

  test("returns mapped JSON transactions", async () => {
    const row = makeTxRow();
    mockQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });

    const result = await getTransactions(testUser);
    expect(result).toHaveLength(1);
    expect(result[0].transaction_id).toBe("tx-1");
    expect(result[0].account_id).toBe("acc-1");
    expect(result[0].name).toBe("Coffee Shop");
    expect(result[0].amount).toBe(5.5);
  });

  test("label fields are nested correctly", async () => {
    const row = makeTxRow({
      label_budget_id: "bud-1",
      label_category_id: "cat-1",
      label_memo: "work lunch",
      label_category_confidence: 0.95,
    });
    mockQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });

    const result = await getTransactions(testUser);
    expect(result[0].label.budget_id).toBe("bud-1");
    expect(result[0].label.category_id).toBe("cat-1");
    expect(result[0].label.memo).toBe("work lunch");
    expect(result[0].label.category_confidence).toBe(0.95);
  });

  test("passes user_id filter to query", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await getTransactions({ user_id: "usr-99", username: "test" });

    const sql = mockQuery.mock.calls[0][0] as string;
    const values = mockQuery.mock.calls[0][1] as string[];
    expect(sql).toContain("transactions");
    expect(values).toContain("usr-99");
  });

  test("passes account_id filter when provided", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await getTransactions(testUser, { account_id: "acc-specific" });

    const values = mockQuery.mock.calls[0][1] as string[];
    expect(values).toContain("acc-specific");
  });

  test("returns multiple transactions", async () => {
    const rows = [makeTxRow({ transaction_id: "tx-1" }), makeTxRow({ transaction_id: "tx-2" })];
    mockQuery.mockResolvedValueOnce({ rows, rowCount: 2 });

    const result = await getTransactions(testUser);
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.transaction_id)).toEqual(["tx-1", "tx-2"]);
  });
});

// ---------------------------------------------------------------------------
// getTransaction
// ---------------------------------------------------------------------------

describe("getTransaction", () => {
  test("returns transaction when found", async () => {
    const row = makeTxRow({ transaction_id: "tx-abc" });
    mockQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });

    const result = await getTransaction(testUser, "tx-abc");
    expect(result).not.toBeNull();
    expect(result?.transaction_id).toBe("tx-abc");
  });

  test("returns null when not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await getTransaction(testUser, "nonexistent");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// searchTransactionsById
// ---------------------------------------------------------------------------

describe("searchTransactionsById", () => {
  test("returns empty array for empty input", async () => {
    const result = await searchTransactionsById(testUser, []);
    expect(result).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("returns transactions for given ids", async () => {
    const rows = [makeTxRow({ transaction_id: "tx-1" }), makeTxRow({ transaction_id: "tx-2" })];
    mockQuery.mockResolvedValueOnce({ rows, rowCount: 2 });

    const result = await searchTransactionsById(testUser, ["tx-1", "tx-2"]);
    expect(result).toHaveLength(2);
  });

  test("includes all ids in query values", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await searchTransactionsById(testUser, ["tx-x", "tx-y", "tx-z"]);

    const values = mockQuery.mock.calls[0][1] as string[];
    expect(values).toContain("tx-x");
    expect(values).toContain("tx-y");
    expect(values).toContain("tx-z");
  });
});

// ---------------------------------------------------------------------------
// upsertTransactions
// ---------------------------------------------------------------------------

describe("upsertTransactions", () => {
  test("returns empty array for empty input", async () => {
    const result = await upsertTransactions(testUser, []);
    expect(result).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("returns UpsertResult for each transaction", async () => {
    // upsert calls pool.query once per transaction
    mockQuery.mockResolvedValue({ rows: [{ transaction_id: "tx-1" }], rowCount: 1 });

    const tx = {
      transaction_id: "tx-1",
      account_id: "acc-1",
      name: "Coffee",
      amount: 5.0,
      date: "2026-03-01",
      pending: false,
      merchant_name: null,
      iso_currency_code: "USD",
    } as Parameters<typeof upsertTransactions>[1][0];

    const result = await upsertTransactions(testUser, [tx]);
    expect(result).toHaveLength(1);
    expect(result[0].update._id).toBe("tx-1");
    expect(result[0].status).toBe(200);
  });

  test("returns error result on query failure", async () => {
    mockQuery.mockRejectedValueOnce(new Error("DB error"));

    const tx = {
      transaction_id: "tx-bad",
      account_id: "acc-1",
      name: "Failed",
      amount: 1.0,
      date: "2026-03-01",
      pending: false,
    } as Parameters<typeof upsertTransactions>[1][0];

    const result = await upsertTransactions(testUser, [tx]);
    expect(result[0].status).toBe(500);
    expect(result[0].update._id).toBe("tx-bad");
  });
});

// ---------------------------------------------------------------------------
// getOldestTransactionDate
// ---------------------------------------------------------------------------

describe("getOldestTransactionDate", () => {
  test("returns date string when transactions exist", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ oldest_date: "2025-01-15" }],
      rowCount: 1,
    });

    const result = await getOldestTransactionDate(testUser);
    expect(result).toBe("2025-01-15");
  });

  test("returns null when no transactions", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await getOldestTransactionDate(testUser);
    expect(result).toBeNull();
  });
});
