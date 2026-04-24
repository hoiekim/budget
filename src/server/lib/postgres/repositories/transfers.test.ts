/**
 * Unit tests for transfers repository
 * Tests getTransferPairs, pairTransactions, confirmTransferPair, removeTransferPair
 * using pool.query mocks.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// Mock pool BEFORE imports
// ---------------------------------------------------------------------------

const mockQuery = mock(
  (_sql: string, _values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }> =>
    Promise.resolve({ rows: [], rowCount: 0 }),
);

mock.module("../client", () => ({
  pool: { query: mockQuery },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { getTransferPairs, pairTransactions, confirmTransferPair, removeTransferPair } from "./transfers";
import { TransactionPaymentChannelEnum } from "plaid";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockUser = { user_id: "usr-1", username: "tester" } as { user_id: string; username: string };

function makeTxRow(overrides: Record<string, unknown> = {}) {
  return {
    transaction_id: "tx-1",
    user_id: "usr-1",
    account_id: "acc-1",
    name: "Transfer Out",
    merchant_name: null,
    amount: 100,
    iso_currency_code: "USD",
    date: "2026-04-01",
    pending: false,
    pending_transaction_id: null,
    payment_channel: TransactionPaymentChannelEnum.Other,
    location_country: null,
    location_region: null,
    location_city: null,
    label_budget_id: null,
    label_category_id: null,
    label_memo: null,
    label_category_confidence: null,
    transfer_pair_id: "pair-uuid-1",
    transfer_status: "suggested",
    raw: null,
    updated: "2026-04-01T00:00:00Z",
    is_deleted: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getTransferPairs", () => {
  beforeEach(() => mockQuery.mockClear());

  test("returns empty array when no transfer pairs exist", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await getTransferPairs(mockUser as never);
    expect(result).toEqual([]);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test("groups two rows with same transfer_pair_id into one pair", async () => {
    const row1 = makeTxRow({ transaction_id: "tx-1", transfer_pair_id: "pair-1", transfer_status: "confirmed" });
    const row2 = makeTxRow({ transaction_id: "tx-2", transfer_pair_id: "pair-1", transfer_status: "confirmed" });
    mockQuery.mockResolvedValueOnce({ rows: [row1, row2], rowCount: 2 });

    const result = await getTransferPairs(mockUser as never);
    expect(result).toHaveLength(1);
    expect(result[0].transfer_pair_id).toBe("pair-1");
    expect(result[0].status).toBe("confirmed");
    expect(result[0].transactions).toHaveLength(2);
  });

  test("handles two separate pairs", async () => {
    const row1 = makeTxRow({ transaction_id: "tx-1", transfer_pair_id: "pair-A" });
    const row2 = makeTxRow({ transaction_id: "tx-2", transfer_pair_id: "pair-A" });
    const row3 = makeTxRow({ transaction_id: "tx-3", transfer_pair_id: "pair-B" });
    const row4 = makeTxRow({ transaction_id: "tx-4", transfer_pair_id: "pair-B" });
    mockQuery.mockResolvedValueOnce({ rows: [row1, row2, row3, row4], rowCount: 4 });

    const result = await getTransferPairs(mockUser as never);
    expect(result).toHaveLength(2);
  });
});

describe("pairTransactions", () => {
  beforeEach(() => mockQuery.mockClear());

  test("returns a pair_id string", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 2 });
    const pair_id = await pairTransactions(mockUser as never, "tx-a", "tx-b");
    expect(typeof pair_id).toBe("string");
    expect(pair_id.length).toBeGreaterThan(0);
  });

  test("issues an UPDATE with the two transaction IDs", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 2 });
    await pairTransactions(mockUser as never, "tx-a", "tx-b", "confirmed");
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("UPDATE");
    expect(values).toContain("confirmed");
    expect(values).toContain("usr-1");
  });
});

describe("confirmTransferPair", () => {
  beforeEach(() => mockQuery.mockClear());

  test("issues UPDATE with confirmed status and pair id", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 2 });
    await confirmTransferPair(mockUser as never, "pair-uuid-1");
    const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("confirmed");
    expect(values).toContain("pair-uuid-1");
    expect(values).toContain("usr-1");
  });
});

describe("removeTransferPair", () => {
  beforeEach(() => mockQuery.mockClear());

  test("issues UPDATE that nulls out pair columns", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 2 });
    await removeTransferPair(mockUser as never, "pair-uuid-1");
    const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("NULL");
    expect(values).toContain("pair-uuid-1");
    expect(values).toContain("usr-1");
  });
});
