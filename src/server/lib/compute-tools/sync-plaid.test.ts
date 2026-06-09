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
    const stored = makeTx({ transaction_id: "PENDING-1", pending_transaction_id: null });
    const incoming = makeTx({
      transaction_id: "POSTED-1",
      pending_transaction_id: "PENDING-1",
    });
    const maps = buildTransactionLookupMaps([stored]);
    const result = detectPendingPostedTransitions([incoming], maps);
    expect(result).toEqual([{ pending: "PENDING-1", posted: "POSTED-1" }]);
  });

  it("does NOT emit on byCompoundKey collisions (recurring same-amount transactions are NOT supersession events)", () => {
    // PR #502 review HIGH #1: recurring same-amount transactions (e.g.
    // monthly Netflix $14.99 on the same account) collide on
    // (account_id, name, amount). The original id-inequality heuristic
    // would have marked the new month's row as the supersession of last
    // month's. Detection via pending_transaction_id back-pointer must
    // NOT fire here — only the back-pointer is authoritative.
    const lastMonth = makeTx({
      transaction_id: "tx-coffee-jan",
      account_id: "acc-1",
      name: "STARBUCKS",
      amount: 5,
      pending_transaction_id: null,
    });
    const thisMonth = makeTx({
      transaction_id: "tx-coffee-feb",
      account_id: "acc-1",
      name: "STARBUCKS",
      amount: 5,
      pending_transaction_id: null,
    });
    const maps = buildTransactionLookupMaps([lastMonth]);
    const result = detectPendingPostedTransitions([thisMonth], maps);
    expect(result).toEqual([]);
  });

  it("does NOT emit when Plaid re-emits an OLD pending tx for which a posted row already exists", () => {
    // PR #502 review HIGH #2: stored has the current posted row
    // pointing back at the old pending (pending_transaction_id="ptx-1").
    // Plaid re-emits the old pending (incoming.transaction_id="ptx-1"
    // with no back-pointer). The id-inequality heuristic would have
    // emitted (pending="tx-settled", posted="ptx-1") — backwards. The
    // back-pointer detection skips because incoming.pending_transaction_id
    // is null.
    const settledPosted = makeTx({
      transaction_id: "tx-settled",
      pending_transaction_id: "ptx-1",
    });
    const reEmittedPending = makeTx({
      transaction_id: "ptx-1",
      pending_transaction_id: null,
    });
    const maps = buildTransactionLookupMaps([settledPosted]);
    const result = detectPendingPostedTransitions([reEmittedPending], maps);
    expect(result).toEqual([]);
  });

  it("does NOT emit when the back-pointer references a transaction not present in the stored set", () => {
    // Defensive: incoming carries a back-pointer to an id we've never
    // seen (the pending row was deleted, never synced, or the user
    // started with this account on a posted-only window). Skip silently.
    const incoming = makeTx({
      transaction_id: "POSTED-orphan",
      pending_transaction_id: "PENDING-not-stored",
    });
    const maps = buildTransactionLookupMaps([]);
    const result = detectPendingPostedTransitions([incoming], maps);
    expect(result).toEqual([]);
  });

  it("does NOT emit when incoming.transaction_id and back-pointer target are the same id (defensive no-op)", () => {
    const stored = makeTx({ transaction_id: "tx-A", pending_transaction_id: null });
    const incoming = makeTx({
      transaction_id: "tx-A",
      pending_transaction_id: "tx-A",
    });
    const maps = buildTransactionLookupMaps([stored]);
    const result = detectPendingPostedTransitions([incoming], maps);
    expect(result).toEqual([]);
  });

  it("handles a batch with mixed shapes — emits only the genuine supersession", () => {
    const oldPending = makeTx({
      transaction_id: "PENDING-1",
      pending_transaction_id: null,
    });
    const recurringJan = makeTx({
      transaction_id: "tx-recurring-jan",
      account_id: "acc-1",
      name: "NETFLIX",
      amount: 14.99,
      pending_transaction_id: null,
    });
    const maps = buildTransactionLookupMaps([oldPending, recurringJan]);

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
    const result = detectPendingPostedTransitions(incoming, maps);
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