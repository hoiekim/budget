import { describe, it, expect } from "bun:test";
import {
  buildTransactionLookupMaps,
  detectPendingPostedTransitions,
  findStoredTransaction,
  getPlaidRemovedInvestmentTransactions,
} from "./sync-plaid";
import type { JSONTransaction, JSONInvestmentTransaction } from "common";

// Minimal factory helpers
const makeTx = (overrides: Partial<JSONTransaction>): JSONTransaction =>
  ({
    transaction_id: "tx-default",
    account_id: "acc-1",
    name: "Coffee",
    amount: 5,
    pending_transaction_id: null,
    label: {},
    ...overrides,
  } as unknown as JSONTransaction);

const makeInvTx = (
  overrides: Partial<JSONInvestmentTransaction>,
): JSONInvestmentTransaction =>
  ({
    investment_transaction_id: "inv-default",
    account_id: "acc-1",
    date: new Date().toISOString().split("T")[0], // today = within TWO_WEEKS
    ...overrides,
  } as unknown as JSONInvestmentTransaction);

// ─── buildTransactionLookupMaps ───────────────────────────────────────────────

describe("buildTransactionLookupMaps", () => {
  it("indexes by transaction_id", () => {
    const tx = makeTx({ transaction_id: "tx-1" });
    const maps = buildTransactionLookupMaps([tx]);
    expect(maps.byTransactionId.get("tx-1")).toBe(tx);
  });

  it("indexes by pending_transaction_id when present", () => {
    const tx = makeTx({ transaction_id: "tx-1", pending_transaction_id: "ptx-1" });
    const maps = buildTransactionLookupMaps([tx]);
    expect(maps.byPendingId.get("ptx-1")).toBe(tx);
  });

  it("does not index pending_transaction_id when null", () => {
    const tx = makeTx({ transaction_id: "tx-1", pending_transaction_id: null });
    const maps = buildTransactionLookupMaps([tx]);
    expect(maps.byPendingId.size).toBe(0);
  });

  it("indexes by compound key account_id:name:amount", () => {
    const tx = makeTx({ transaction_id: "tx-1", account_id: "acc-1", name: "Coffee", amount: 5 });
    const maps = buildTransactionLookupMaps([tx]);
    expect(maps.byCompoundKey.get("acc-1:Coffee:5")).toBe(tx);
  });

  it("handles multiple transactions", () => {
    const tx1 = makeTx({ transaction_id: "tx-1" });
    const tx2 = makeTx({ transaction_id: "tx-2" });
    const maps = buildTransactionLookupMaps([tx1, tx2]);
    expect(maps.byTransactionId.size).toBe(2);
  });
});

// ─── findStoredTransaction ────────────────────────────────────────────────────

describe("findStoredTransaction", () => {
  it("matches by transaction_id", () => {
    const stored = makeTx({ transaction_id: "tx-1" });
    const maps = buildTransactionLookupMaps([stored]);
    const result = findStoredTransaction(
      { transaction_id: "tx-1", account_id: "acc-X", name: "Other", amount: 999 },
      maps,
    );
    expect(result).toBe(stored);
  });

  it("matches by pending_transaction_id", () => {
    const stored = makeTx({ transaction_id: "tx-settled", pending_transaction_id: "ptx-1" });
    const maps = buildTransactionLookupMaps([stored]);
    const result = findStoredTransaction(
      { transaction_id: "ptx-1", account_id: "acc-X", name: "Other", amount: 999 },
      maps,
    );
    expect(result).toBe(stored);
  });

  it("matches by compound key when id lookups miss", () => {
    const stored = makeTx({ transaction_id: "tx-old", account_id: "acc-1", name: "Coffee", amount: 5 });
    const maps = buildTransactionLookupMaps([stored]);
    const result = findStoredTransaction(
      { transaction_id: "tx-new", account_id: "acc-1", name: "Coffee", amount: 5 },
      maps,
    );
    expect(result).toBe(stored);
  });

  it("returns undefined when no match found", () => {
    const stored = makeTx({ transaction_id: "tx-1", account_id: "acc-1", name: "Coffee", amount: 5 });
    const maps = buildTransactionLookupMaps([stored]);
    const result = findStoredTransaction(
      { transaction_id: "tx-2", account_id: "acc-2", name: "Tea", amount: 3 },
      maps,
    );
    expect(result).toBeUndefined();
  });

  it("preserves label from stored transaction", () => {
    const stored = makeTx({ transaction_id: "tx-1", label: { budget_id: "b-1" } as never });
    const maps = buildTransactionLookupMaps([stored]);
    const result = findStoredTransaction({ transaction_id: "tx-1", account_id: "", name: "", amount: 0 }, maps);
    expect(result?.label).toEqual({ budget_id: "b-1" });
  });
});

// ─── detectPendingPostedTransitions ───────────────────────────────────────────

describe("detectPendingPostedTransitions", () => {
  it("emits a transition for the canonical pending→posted shape (incoming carries pending_transaction_id back-pointer)", () => {
    const incoming = makeTx({
      transaction_id: "POSTED-1",
      pending_transaction_id: "PENDING-1",
    });
    const result = detectPendingPostedTransitions([incoming]);
    expect(result).toEqual([{ pending: "PENDING-1", posted: "POSTED-1" }]);
  });

  it("does NOT emit when no back-pointer is set — covers recurring same-amount transactions and brand-new posted-only txs", () => {
    // Recurring monthly charges (Netflix $14.99, etc.) appear as brand-new
    // transactions every month with a fresh transaction_id and no
    // pending_transaction_id. The back-pointer being null is the only
    // signal we need — no need to cross-check stored set.
    const recurring = makeTx({
      transaction_id: "tx-recurring-feb",
      account_id: "acc-1",
      name: "NETFLIX",
      amount: 14.99,
      pending_transaction_id: null,
    });
    expect(detectPendingPostedTransitions([recurring])).toEqual([]);
  });

  it("does NOT emit when Plaid re-emits an OLD pending tx (incoming.pending_transaction_id is null)", () => {
    // A re-emitted pending row has no back-pointer (Plaid hasn't yet
    // posted it from THIS sync's perspective). The detection short-
    // circuits cleanly.
    const reEmittedPending = makeTx({
      transaction_id: "ptx-1",
      pending_transaction_id: null,
    });
    expect(detectPendingPostedTransitions([reEmittedPending])).toEqual([]);
  });

  it("does NOT emit when incoming.transaction_id and back-pointer target are the same id (defensive no-op)", () => {
    const incoming = makeTx({
      transaction_id: "tx-A",
      pending_transaction_id: "tx-A",
    });
    expect(detectPendingPostedTransitions([incoming])).toEqual([]);
  });

  it("handles a batch with mixed shapes — emits only the genuine supersession", () => {
    const incoming = [
      // (1) canonical pending→posted — should emit
      makeTx({ transaction_id: "POSTED-1", pending_transaction_id: "PENDING-1" }),
      // (2) recurring same-amount charge — should NOT emit
      makeTx({
        transaction_id: "tx-recurring-feb",
        account_id: "acc-1",
        name: "NETFLIX",
        amount: 14.99,
        pending_transaction_id: null,
      }),
      // (3) brand-new tx with no back-pointer — should NOT emit
      makeTx({ transaction_id: "tx-fresh", pending_transaction_id: null }),
    ];
    const result = detectPendingPostedTransitions(incoming);
    expect(result).toEqual([{ pending: "PENDING-1", posted: "POSTED-1" }]);
  });
});

// ─── getPlaidRemovedInvestmentTransactions ────────────────────────────────────

describe("getPlaidRemovedInvestmentTransactions", () => {
  it("returns empty when all stored transactions are still incoming", () => {
    const incoming = [makeInvTx({ investment_transaction_id: "inv-1" })];
    const stored = [makeInvTx({ investment_transaction_id: "inv-1" })];
    expect(getPlaidRemovedInvestmentTransactions(incoming, stored)).toHaveLength(0);
  });

  it("identifies removed recent transactions", () => {
    const incoming = [makeInvTx({ investment_transaction_id: "inv-1" })];
    const stored = [
      makeInvTx({ investment_transaction_id: "inv-1" }),
      makeInvTx({ investment_transaction_id: "inv-2" }),
    ];
    const result = getPlaidRemovedInvestmentTransactions(incoming, stored);
    expect(result).toHaveLength(1);
    expect(result[0].investment_transaction_id).toBe("inv-2");
  });

  it("does not flag old transactions (> TWO_WEEKS) as removed", () => {
    const oldDate = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const incoming: JSONInvestmentTransaction[] = [];
    const stored = [makeInvTx({ investment_transaction_id: "inv-old", date: oldDate })];
    const result = getPlaidRemovedInvestmentTransactions(incoming, stored);
    expect(result).toHaveLength(0);
  });

  it("returns empty when stored list is empty", () => {
    const incoming = [makeInvTx({ investment_transaction_id: "inv-1" })];
    expect(getPlaidRemovedInvestmentTransactions(incoming, [])).toHaveLength(0);
  });

  it("returns all recent stored when incoming is empty", () => {
    const stored = [
      makeInvTx({ investment_transaction_id: "inv-1" }),
      makeInvTx({ investment_transaction_id: "inv-2" }),
    ];
    const result = getPlaidRemovedInvestmentTransactions([], stored);
    expect(result).toHaveLength(2);
  });
});