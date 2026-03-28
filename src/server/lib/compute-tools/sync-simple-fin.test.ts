import { describe, it, expect } from "bun:test";
import {
  getRemovedTransactions,
  getRemovedInvestmentTransactions,
} from "./sync-simple-fin";
import type { JSONTransaction } from "common";
import type { JSONInvestmentTransaction } from "common";

// Minimal factory helpers to avoid typing every field
const makeTx = (overrides: Partial<JSONTransaction>): JSONTransaction =>
  ({
    transaction_id: "tx-default",
    account_id: "acc-1",
    date: "2026-01-15",
    name: "Test",
    amount: 10,
    pending_transaction_id: null,
    authorized_date: null,
    authorized_datetime: null,
    datetime: null,
    ...overrides,
  } as unknown as JSONTransaction);

const makeInvTx = (
  overrides: Partial<JSONInvestmentTransaction>,
): JSONInvestmentTransaction =>
  ({
    investment_transaction_id: "inv-default",
    account_id: "acc-1",
    date: "2026-01-15",
    ...overrides,
  } as unknown as JSONInvestmentTransaction);

const START_DATE = new Date("2026-01-01");

describe("getRemovedTransactions", () => {
  it("returns empty when all stored transactions are still present", () => {
    const incoming = [makeTx({ transaction_id: "tx-1" })];
    const stored = [makeTx({ transaction_id: "tx-1" })];
    expect(getRemovedTransactions(incoming, stored, START_DATE)).toEqual([]);
  });

  it("identifies removed transactions", () => {
    const incoming = [makeTx({ transaction_id: "tx-1" })];
    const stored = [
      makeTx({ transaction_id: "tx-1" }),
      makeTx({ transaction_id: "tx-2" }),
    ];
    const result = getRemovedTransactions(incoming, stored, START_DATE);
    expect(result).toHaveLength(1);
    expect(result[0].transaction_id).toBe("tx-2");
  });

  it("ignores stored transactions before startDate", () => {
    const incoming: JSONTransaction[] = [];
    const stored = [makeTx({ transaction_id: "tx-old", date: "2025-12-31" })];
    const result = getRemovedTransactions(incoming, stored, START_DATE);
    expect(result).toEqual([]);
  });

  it("ignores stored transactions from different accounts (not in incoming)", () => {
    // If the account_id is not in incoming accounts, the stored transaction is not removed
    const incoming = [makeTx({ transaction_id: "tx-1", account_id: "acc-1" })];
    const stored = [makeTx({ transaction_id: "tx-2", account_id: "acc-2" })];
    const result = getRemovedTransactions(incoming, stored, START_DATE);
    expect(result).toEqual([]);
  });

  it("handles multiple removed transactions across same account", () => {
    const incoming = [makeTx({ transaction_id: "tx-1", account_id: "acc-1" })];
    const stored = [
      makeTx({ transaction_id: "tx-1", account_id: "acc-1" }),
      makeTx({ transaction_id: "tx-2", account_id: "acc-1" }),
      makeTx({ transaction_id: "tx-3", account_id: "acc-1" }),
    ];
    const result = getRemovedTransactions(incoming, stored, START_DATE);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.transaction_id).sort()).toEqual(["tx-2", "tx-3"]);
  });

  it("returns empty when stored is empty", () => {
    const incoming = [makeTx({ transaction_id: "tx-1" })];
    expect(getRemovedTransactions(incoming, [], START_DATE)).toEqual([]);
  });
});

describe("getRemovedInvestmentTransactions", () => {
  it("returns empty when all stored investment transactions are still present", () => {
    const incoming = [makeInvTx({ investment_transaction_id: "inv-1" })];
    const stored = [makeInvTx({ investment_transaction_id: "inv-1" })];
    expect(
      getRemovedInvestmentTransactions(incoming, stored, START_DATE),
    ).toEqual([]);
  });

  it("identifies removed investment transactions", () => {
    const incoming = [makeInvTx({ investment_transaction_id: "inv-1" })];
    const stored = [
      makeInvTx({ investment_transaction_id: "inv-1" }),
      makeInvTx({ investment_transaction_id: "inv-2" }),
    ];
    const result = getRemovedInvestmentTransactions(incoming, stored, START_DATE);
    expect(result).toHaveLength(1);
    expect(result[0].investment_transaction_id).toBe("inv-2");
  });

  it("ignores stored investment transactions before startDate", () => {
    const incoming: JSONInvestmentTransaction[] = [];
    const stored = [
      makeInvTx({ investment_transaction_id: "inv-old", date: "2025-12-31" }),
    ];
    const result = getRemovedInvestmentTransactions(incoming, stored, START_DATE);
    expect(result).toEqual([]);
  });

  it("ignores stored investment transactions from different accounts", () => {
    const incoming = [
      makeInvTx({ investment_transaction_id: "inv-1", account_id: "acc-1" }),
    ];
    const stored = [
      makeInvTx({ investment_transaction_id: "inv-2", account_id: "acc-2" }),
    ];
    const result = getRemovedInvestmentTransactions(incoming, stored, START_DATE);
    expect(result).toEqual([]);
  });

  it("handles multiple removed investment transactions", () => {
    const incoming = [
      makeInvTx({ investment_transaction_id: "inv-1", account_id: "acc-1" }),
    ];
    const stored = [
      makeInvTx({ investment_transaction_id: "inv-1", account_id: "acc-1" }),
      makeInvTx({ investment_transaction_id: "inv-2", account_id: "acc-1" }),
      makeInvTx({ investment_transaction_id: "inv-3", account_id: "acc-1" }),
    ];
    const result = getRemovedInvestmentTransactions(incoming, stored, START_DATE);
    expect(result).toHaveLength(2);
    expect(
      result.map((r) => r.investment_transaction_id).sort(),
    ).toEqual(["inv-2", "inv-3"]);
  });

  it("returns empty when stored is empty", () => {
    const incoming = [makeInvTx({ investment_transaction_id: "inv-1" })];
    expect(
      getRemovedInvestmentTransactions(incoming, [], START_DATE),
    ).toEqual([]);
  });
});
