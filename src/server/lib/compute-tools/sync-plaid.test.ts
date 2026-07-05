import { describe, it, expect } from "bun:test";
import {
  buildTransactionLookupMaps,
  detectPendingPostedTransitions,
  findStoredTransaction,
  getPlaidRemovedInvestmentTransactions,
  remapHoldingSecurityIds,
} from "./sync-plaid";
import type { JSONTransaction, JSONInvestmentTransaction, JSONHolding } from "common";

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

describe("remapHoldingSecurityIds (#593 reconciliation)", () => {
  const mkHolding = (holding_id: string, security_id: string): JSONHolding =>
    ({
      holding_id,
      account_id: "acc-1",
      security_id,
      quantity: 1,
      institution_price: 100,
      institution_value: 100,
      cost_basis: null,
      iso_currency_code: "USD",
    }) as unknown as JSONHolding;

  it("remaps holdings whose security_id has a canonical mapping in idMap", () => {
    const holdings = [
      mkHolding("h-1", "plaid-1"),
      mkHolding("h-2", "plaid-2"),
    ];
    const idMap = { "plaid-1": "manual-1", "plaid-2": "plaid-2" };
    const result = remapHoldingSecurityIds(holdings, idMap);
    expect(result[0].security_id).toBe("manual-1"); // remapped
    expect(result[1].security_id).toBe("plaid-2"); // identity — unchanged
  });

  it("leaves holdings unchanged when idMap has no entry (security was filtered out of the dedupe pass — e.g. no ticker_symbol or no close_price)", () => {
    const holdings = [mkHolding("h-cash", "cash-sec")];
    const idMap = {}; // dedupe skipped this security
    const result = remapHoldingSecurityIds(holdings, idMap);
    expect(result[0].security_id).toBe("cash-sec");
    expect(result[0]).toBe(holdings[0]); // identity preserved (no allocation)
  });

  it("identity-preserves holdings when canonical id matches the incoming id (no allocation for the no-op case)", () => {
    const holdings = [mkHolding("h-1", "sec-a")];
    const idMap = { "sec-a": "sec-a" };
    const result = remapHoldingSecurityIds(holdings, idMap);
    expect(result[0]).toBe(holdings[0]); // same reference
  });

  it("preserves non-security fields when remapping", () => {
    const holdings = [
      { ...mkHolding("h-1", "plaid-1"), quantity: 42, cost_basis: 1234.5 },
    ];
    const idMap = { "plaid-1": "manual-1" };
    const result = remapHoldingSecurityIds(holdings as JSONHolding[], idMap);
    expect(result[0].security_id).toBe("manual-1");
    expect(result[0].quantity).toBe(42);
    expect(result[0].cost_basis).toBe(1234.5);
    expect(result[0].holding_id).toBe("h-1");
  });

  it("closes #593 gap 2: user-minted (manual) security id survives Plaid re-arrival for the same ticker", () => {
    // Scenario: user posted /api/validate-ticker for VOO, minting security
    // 'manual-voo'. Later Plaid syncs a holding for VOO with its own id
    // 'plaid-voo'. upsertSecuritiesWithSnapshots ticker-dedupes and returns
    // { 'plaid-voo' → 'manual-voo' }. If the sync-plaid remap step
    // regresses (holding written pre-dedupe), the holding's security_id
    // is 'plaid-voo' — but the securities table no longer has that row
    // (it was upserted under 'manual-voo'), so the holding orphans.
    const holdings = [mkHolding("acc-1_plaid-voo", "plaid-voo")];
    const idMap = { "plaid-voo": "manual-voo" };
    const result = remapHoldingSecurityIds(holdings, idMap);
    expect(result[0].security_id).toBe("manual-voo");
    // holding_id itself is not remapped in this step — the caller
    // (`upsertAndDeleteHoldingsWithSnapshots`) rewrites it from the
    // holding row's fields on its next pass, so the persisted row
    // eventually keys on the canonical (account_id, security_id) pair.
  });
});
