/**
 * Unit tests for transfers repository (transaction_pairs table model).
 * Covers getTransferPairs, pairTransactions, confirmTransferPair, removeTransferPair
 * with pool.query mocked.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

const mockQuery = mock(
  (_sql: string, _values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }> =>
    Promise.resolve({ rows: [], rowCount: 0 }),
);

mock.module("../client", () => ({
  pool: { query: mockQuery },
}));

import {
  getTransferPairs,
  pairTransactions,
  confirmTransferPair,
  removeTransferPair,
} from "./transfers";
import { canonicalizePairIds } from "../models/transaction_pair";
import { TransactionPaymentChannelEnum } from "plaid";

const mockUser = { user_id: "usr-1", username: "tester" } as { user_id: string; username: string };

function makePairRow(overrides: Record<string, unknown> = {}) {
  return {
    pair_id: "pair-1",
    user_id: "usr-1",
    transaction_id_a: "tx-1",
    transaction_id_b: "tx-2",
    status: "suggested",
    updated: "2026-04-01T00:00:00Z",
    is_deleted: false,
    ...overrides,
  };
}

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
    raw: null,
    updated: "2026-04-01T00:00:00Z",
    is_deleted: false,
    ...overrides,
  };
}

describe("getTransferPairs", () => {
  beforeEach(() => mockQuery.mockClear());

  test("returns empty array when no pairs exist (no transactions query issued)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await getTransferPairs(mockUser as never);
    expect(result).toEqual([]);
    expect(mockQuery).toHaveBeenCalledTimes(1); // only the pairs query, no follow-up
  });

  test("loads paired transactions and returns one entry per pair", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makePairRow({ pair_id: "pair-1", transaction_id_a: "tx-1", transaction_id_b: "tx-2", status: "confirmed" })],
      rowCount: 1,
    });
    mockQuery.mockResolvedValueOnce({
      rows: [makeTxRow({ transaction_id: "tx-1" }), makeTxRow({ transaction_id: "tx-2" })],
      rowCount: 2,
    });

    const result = await getTransferPairs(mockUser as never);
    expect(result).toHaveLength(1);
    expect(result[0].pair_id).toBe("pair-1");
    expect(result[0].status).toBe("confirmed");
    expect(result[0].transactions).toHaveLength(2);
  });

  test("drops a pair whose transactions are not retrievable (e.g. soft-deleted)", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makePairRow({ pair_id: "pair-1", transaction_id_a: "tx-1", transaction_id_b: "tx-MISSING" })],
      rowCount: 1,
    });
    mockQuery.mockResolvedValueOnce({
      rows: [makeTxRow({ transaction_id: "tx-1" })], // tx-MISSING absent
      rowCount: 1,
    });

    const result = await getTransferPairs(mockUser as never);
    expect(result).toEqual([]);
  });

  test("scopes both queries by user_id", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makePairRow()],
      rowCount: 1,
    });
    mockQuery.mockResolvedValueOnce({
      rows: [makeTxRow({ transaction_id: "tx-1" }), makeTxRow({ transaction_id: "tx-2" })],
      rowCount: 2,
    });
    await getTransferPairs(mockUser as never);
    const [, pairValues] = mockQuery.mock.calls[0] as [string, unknown[]];
    const [, txValues] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(pairValues).toContain("usr-1");
    expect(txValues).toContain("usr-1");
  });
});

describe("pairTransactions", () => {
  beforeEach(() => mockQuery.mockClear());

  test("INSERTs into transaction_pairs and returns a pair_id", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const pair_id = await pairTransactions(mockUser as never, "tx-a", "tx-b");
    expect(typeof pair_id).toBe("string");
    expect(pair_id.length).toBeGreaterThan(0);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO transaction_pairs");
    expect(values).toContain("usr-1");
    expect(values).toContain("suggested");
  });

  test("canonicalizes (a, b) so reversed inputs hit the same row shape", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await pairTransactions(mockUser as never, "tx-z", "tx-a");
    const [, values] = mockQuery.mock.calls[0] as [string, unknown[]];
    // canonical: tx-a < tx-z so transaction_id_a = "tx-a", transaction_id_b = "tx-z"
    const idxA = values.indexOf("tx-a");
    const idxB = values.indexOf("tx-z");
    expect(idxA).toBeLessThan(idxB);
  });

  test("accepts confirmed status", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await pairTransactions(mockUser as never, "tx-a", "tx-b", "confirmed");
    const [, values] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(values).toContain("confirmed");
  });
});

describe("confirmTransferPair", () => {
  beforeEach(() => mockQuery.mockClear());

  test("UPDATEs the pair row by pair_id with confirmed status", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await confirmTransferPair(mockUser as never, "pair-1");
    const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("UPDATE transaction_pairs");
    expect(sql).toContain("'confirmed'");
    expect(values).toContain("pair-1");
    expect(values).toContain("usr-1");
  });
});

describe("removeTransferPair", () => {
  beforeEach(() => mockQuery.mockClear());

  test("soft-deletes the pair row (does not touch transactions)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await removeTransferPair(mockUser as never, "pair-1");
    expect(mockQuery).toHaveBeenCalledTimes(1); // single UPDATE, no fan-out to transactions
    const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("UPDATE transaction_pairs");
    expect(sql).toContain("is_deleted = TRUE");
    expect(values).toContain("pair-1");
    expect(values).toContain("usr-1");
  });
});

describe("canonicalizePairIds", () => {
  test("returns lexicographically smaller id as a", () => {
    expect(canonicalizePairIds("z", "a")).toEqual({
      transaction_id_a: "a",
      transaction_id_b: "z",
    });
    expect(canonicalizePairIds("a", "z")).toEqual({
      transaction_id_a: "a",
      transaction_id_b: "z",
    });
  });
});
