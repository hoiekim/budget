import { describe, it, expect } from "bun:test";
import {
  buildTransactionLookupMaps,
  detectAccountIdChurn,
  detectPendingPostedTransitions,
  findStoredTransaction,
  getPlaidRemovedInvestmentTransactions,
} from "./sync-plaid";
import type { JSONAccount, JSONTransaction, JSONInvestmentTransaction } from "common";

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

const makeAccount = (overrides: Partial<JSONAccount>): JSONAccount =>
  ({
    account_id: "acc-new",
    item_id: "item-1",
    name: "Everyday Checking",
    mask: "1234",
    subtype: "checking",
    ...overrides,
  } as unknown as JSONAccount);

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

  it("handles multiple transactions", () => {
    const tx1 = makeTx({ transaction_id: "tx-1" });
    const tx2 = makeTx({ transaction_id: "tx-2" });
    const maps = buildTransactionLookupMaps([tx1, tx2]);
    expect(maps.byTransactionId.size).toBe(2);
  });
});

// ─── findStoredTransaction ────────────────────────────────────────────────────

describe("findStoredTransaction", () => {
  it("matches by transaction_id (Plaid re-serves the same id)", () => {
    const stored = makeTx({ transaction_id: "tx-1" });
    const maps = buildTransactionLookupMaps([stored]);
    const result = findStoredTransaction(
      { transaction_id: "tx-1", pending_transaction_id: null },
      maps,
    );
    expect(result).toBe(stored);
  });

  it("matches when incoming.pending_transaction_id equals a stored transaction_id (canonical pending→posted, the primary label-inherit path)", () => {
    const storedPending = makeTx({
      transaction_id: "PENDING-1",
      pending_transaction_id: null,
      label: { budget_id: "b-1" } as never,
    });
    const maps = buildTransactionLookupMaps([storedPending]);
    const result = findStoredTransaction(
      { transaction_id: "POSTED-1", pending_transaction_id: "PENDING-1" },
      maps,
    );
    expect(result).toBe(storedPending);
    expect(result?.label).toEqual({ budget_id: "b-1" });
  });

  it("matches via byPendingId when incoming's id equals a stored row's pending_transaction_id (mirror-image edge case)", () => {
    const storedPosted = makeTx({
      transaction_id: "POSTED-1",
      pending_transaction_id: "ptx-1",
    });
    const maps = buildTransactionLookupMaps([storedPosted]);
    const result = findStoredTransaction(
      { transaction_id: "ptx-1", pending_transaction_id: null },
      maps,
    );
    expect(result).toBe(storedPosted);
  });

  it("prefers the exact transaction_id match over the pending_transaction_id fallback", () => {
    const exactMatch = makeTx({
      transaction_id: "tx-1",
      label: { budget_id: "b-exact" } as never,
    });
    const pendingMatch = makeTx({
      transaction_id: "PENDING-1",
      label: { budget_id: "b-pending" } as never,
    });
    const maps = buildTransactionLookupMaps([exactMatch, pendingMatch]);
    const result = findStoredTransaction(
      { transaction_id: "tx-1", pending_transaction_id: "PENDING-1" },
      maps,
    );
    expect(result).toBe(exactMatch);
    expect(result?.label).toEqual({ budget_id: "b-exact" });
  });

  it("returns undefined when no id-based match exists (recurring same-name-and-amount rows are no longer a false match)", () => {
    // `thisMonth` INTENTIONALLY carries the same (account_id, name, amount)
    // triple as `lastMonth`. Under the narrowed
    // `Pick<..., "transaction_id" | "pending_transaction_id">` signature
    // these fields are stripped from the type, so we cast to any at the
    // boundary — the discriminator MUST be present at runtime for the
    // test to be mutation-tight: a compound-key lookup on an incoming
    // stripped to `{transaction_id, pending_transaction_id}` would key
    // off `"undefined:undefined:undefined"` and miss the stored row's
    // `"acc-1:NETFLIX:14.99"` even if the fallback were re-added.
    const lastMonth = makeTx({
      transaction_id: "tx-jan",
      account_id: "acc-1",
      name: "NETFLIX",
      amount: 14.99,
      label: { budget_id: "b-subs" } as never,
    });
    const maps = buildTransactionLookupMaps([lastMonth]);
    const thisMonth = findStoredTransaction(
      {
        transaction_id: "tx-feb",
        pending_transaction_id: null,
        account_id: "acc-1",
        name: "NETFLIX",
        amount: 14.99,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      maps,
    );
    expect(thisMonth).toBeUndefined();
  });

  it("returns undefined when incoming has no pending_transaction_id and no id match", () => {
    const stored = makeTx({ transaction_id: "tx-1" });
    const maps = buildTransactionLookupMaps([stored]);
    const result = findStoredTransaction(
      { transaction_id: "tx-fresh", pending_transaction_id: null },
      maps,
    );
    expect(result).toBeUndefined();
  });

  it("preserves label from stored transaction on the exact-id path", () => {
    const stored = makeTx({
      transaction_id: "tx-1",
      label: { budget_id: "b-1" } as never,
    });
    const maps = buildTransactionLookupMaps([stored]);
    const result = findStoredTransaction(
      { transaction_id: "tx-1", pending_transaction_id: null },
      maps,
    );
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

// ─── detectAccountIdChurn ───────────────────────────────────────────────────
describe("detectAccountIdChurn", () => {
  const stored = [makeAccount({ account_id: "acc-old" })];

  it("emits a churn pair for a new id matching name (case-insensitive) + mask + subtype on the same item", () => {
    const incoming = [makeAccount({ account_id: "acc-new", name: "everyday checking" })];
    expect(detectAccountIdChurn(incoming, stored)).toEqual([
      {
        item_id: "item-1",
        old_account_id: "acc-old",
        new_account_id: "acc-new",
        name: "everyday checking",
        mask: "1234",
        subtype: "checking",
      },
    ]);
  });

  it("does NOT emit when the incoming id is already stored", () => {
    const incoming = [makeAccount({ account_id: "acc-old" })];
    expect(detectAccountIdChurn(incoming, stored)).toEqual([]);
  });

  it("does NOT emit when the mask differs — two cards from the same bank can share a name", () => {
    const incoming = [makeAccount({ account_id: "acc-new", mask: "5678" })];
    expect(detectAccountIdChurn(incoming, stored)).toEqual([]);
  });

  it("does NOT emit when the subtype differs", () => {
    const incoming = [makeAccount({ account_id: "acc-new", subtype: "savings" })];
    expect(detectAccountIdChurn(incoming, stored)).toEqual([]);
  });

  it("does NOT emit when the name differs beyond case", () => {
    const incoming = [makeAccount({ account_id: "acc-new", name: "Everyday Savings" })];
    expect(detectAccountIdChurn(incoming, stored)).toEqual([]);
  });

  it("does NOT emit when the matching stored account is on a different item", () => {
    const incoming = [makeAccount({ account_id: "acc-new", item_id: "item-2" })];
    expect(detectAccountIdChurn(incoming, stored)).toEqual([]);
  });

  it("handles a batch — emits only the genuine churn pair", () => {
    const incoming = [
      makeAccount({ account_id: "acc-new", name: "everyday checking" }),
      makeAccount({ account_id: "acc-brand-new", name: "Travel Rewards", mask: "9999" }),
      makeAccount({ account_id: "acc-old" }),
    ];
    expect(detectAccountIdChurn(incoming, stored)).toEqual([
      {
        item_id: "item-1",
        old_account_id: "acc-old",
        new_account_id: "acc-new",
        name: "everyday checking",
        mask: "1234",
        subtype: "checking",
      },
    ]);
  });

  it("prefers the live successor over an archived predecessor when both match", () => {
    // Card Issuer G shape: an archived predecessor and the live successor
    // share (name, mask, subtype); the provider re-issues the successor's
    // id, so the alarm must name the successor, not the dead end.
    const storedBoth = [
      makeAccount({ account_id: "acc-archived", archived: true }),
      makeAccount({ account_id: "acc-live", archived: false }),
    ];
    expect(detectAccountIdChurn([makeAccount({ account_id: "acc-new" })], storedBoth)).toEqual([
      {
        item_id: "item-1",
        old_account_id: "acc-live",
        new_account_id: "acc-new",
        name: "Everyday Checking",
        mask: "1234",
        subtype: "checking",
      },
    ]);
  });

  it("reports every tied sibling when all matches are archived", () => {
    // Two archived predecessors and no live successor: the true predecessor
    // is unknowable from these fields, so no single old id may be named.
    const storedBoth = [
      makeAccount({ account_id: "acc-old-1", archived: true }),
      makeAccount({ account_id: "acc-old-2", archived: true }),
    ];
    expect(detectAccountIdChurn([makeAccount({ account_id: "acc-new" })], storedBoth)).toEqual([
      {
        item_id: "item-1",
        old_account_id: "acc-old-1",
        new_account_id: "acc-new",
        name: "Everyday Checking",
        mask: "1234",
        subtype: "checking",
      },
      {
        item_id: "item-1",
        old_account_id: "acc-old-2",
        new_account_id: "acc-new",
        name: "Everyday Checking",
        mask: "1234",
        subtype: "checking",
      },
    ]);
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

  it("does not flag manually-entered (source='manual') transactions as removed", () => {
    // Manual invest txns can live on a Plaid brokerage (RSU/ESPP) and never appear
    // in Plaid's incoming list — they must not be soft-deleted by sync.
    const incoming: JSONInvestmentTransaction[] = [];
    const stored = [
      makeInvTx({ investment_transaction_id: "manual-1", source: "manual" }),
    ];
    const result = getPlaidRemovedInvestmentTransactions(incoming, stored);
    expect(result).toHaveLength(0);
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