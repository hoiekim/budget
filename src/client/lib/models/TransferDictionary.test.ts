import { test, expect, describe } from "bun:test";
import type { TransferPair } from "server";
import { TransactionDictionary, TransferDictionary, resolveTransferSides } from "./Data";

// Build a one-pair dictionary whose two halves carry the given ids and
// status. Mirrors what `data.transfers` holds after `fetchTransfers`.
const makePair = (
  pair_id: string,
  status: TransferPair["status"],
  transaction_ids: [string, string],
): TransferPair => ({
  pair_id,
  status,
  transactions: transaction_ids.map((id) => ({ transaction_id: id }) as never),
});

describe("TransferDictionary.byTransactionId", () => {
  const dict = new TransferDictionary();
  dict.set("conf", makePair("conf", "confirmed", ["c1", "c2"]));
  dict.set("sugg", makePair("sugg", "suggested", ["s1", "s2"]));

  test("get returns the pair for either half, undefined for a non-member", () => {
    expect(dict.byTransactionId.get("c1")?.pair_id).toBe("conf");
    expect(dict.byTransactionId.get("c2")?.pair_id).toBe("conf");
    expect(dict.byTransactionId.get("s1")?.pair_id).toBe("sugg");
    expect(dict.byTransactionId.get("nope")).toBeUndefined();
  });

  test("has answers membership regardless of status", () => {
    expect(dict.byTransactionId.has("c1")).toBe(true);
    expect(dict.byTransactionId.has("s2")).toBe(true);
    expect(dict.byTransactionId.has("nope")).toBe(false);
  });

  test("hasConfirmed is true only for halves of a confirmed pair", () => {
    expect(dict.byTransactionId.hasConfirmed("c1")).toBe(true);
    expect(dict.byTransactionId.hasConfirmed("c2")).toBe(true);
    expect(dict.byTransactionId.hasConfirmed("s1")).toBe(false);
    expect(dict.byTransactionId.hasConfirmed("nope")).toBe(false);
  });

  test("hasSuggested is true only for halves of a suggested pair", () => {
    expect(dict.byTransactionId.hasSuggested("s1")).toBe(true);
    expect(dict.byTransactionId.hasSuggested("s2")).toBe(true);
    expect(dict.byTransactionId.hasSuggested("c1")).toBe(false);
    expect(dict.byTransactionId.hasSuggested("nope")).toBe(false);
  });

  test("status flips follow set(): re-setting a pair as confirmed updates the predicates", () => {
    const d = new TransferDictionary();
    d.set("p", makePair("p", "suggested", ["a", "b"]));
    expect(d.byTransactionId.hasSuggested("a")).toBe(true);
    expect(d.byTransactionId.hasConfirmed("a")).toBe(false);
    d.set("p", makePair("p", "confirmed", ["a", "b"]));
    expect(d.byTransactionId.hasSuggested("a")).toBe(false);
    expect(d.byTransactionId.hasConfirmed("a")).toBe(true);
  });

  test("delete evicts both halves from the pivot", () => {
    const d = new TransferDictionary();
    d.set("p", makePair("p", "confirmed", ["a", "b"]));
    expect(d.byTransactionId.has("a")).toBe(true);
    d.delete("p");
    expect(d.byTransactionId.has("a")).toBe(false);
    expect(d.byTransactionId.has("b")).toBe(false);
  });

  test("pivot is hydrated from the constructor init (not just incremental set)", () => {
    const seed = new TransferDictionary();
    seed.set("p", makePair("p", "confirmed", ["a", "b"]));
    const copy = new TransferDictionary(seed);
    expect(copy.byTransactionId.hasConfirmed("a")).toBe(true);
    expect(copy.byTransactionId.get("b")?.pair_id).toBe("p");
  });
});

describe("resolveTransferSides", () => {
  // The pair's embedded halves are a copy taken when the pair row was last
  // written. Nothing bumps `transaction_pairs.updated` when a referenced
  // transaction changes, so under delta sync that copy goes stale while
  // `data.transactions` carries the edit.
  const stalePair = (): TransferPair => ({
    pair_id: "p",
    status: "confirmed",
    transactions: [
      { transaction_id: "t-a", amount: 10, name: "old name" } as never,
      { transaction_id: "t-b", amount: -10, name: "old name" } as never,
    ],
  });

  test("reads each half through the authoritative transactions dictionary", () => {
    const transactions = new TransactionDictionary();
    transactions.set("t-a", { transaction_id: "t-a", amount: 12.34, name: "new name" } as never);
    transactions.set("t-b", { transaction_id: "t-b", amount: -12.34, name: "new name" } as never);

    const [a, b] = resolveTransferSides(stalePair(), transactions);
    expect(a.amount).toBe(12.34);
    expect(b.amount).toBe(-12.34);
    expect(a.name).toBe("new name");
  });

  test("falls back to the embedded copy for a half that is not loaded", () => {
    const transactions = new TransactionDictionary();
    transactions.set("t-a", { transaction_id: "t-a", amount: 12.34, name: "new name" } as never);

    const [a, b] = resolveTransferSides(stalePair(), transactions);
    expect(a.amount).toBe(12.34);
    // t-b is outside the loaded window (or soft-deleted) — the row still
    // renders rather than blanking a side.
    expect(b.amount).toBe(-10);
    expect(b.transaction_id).toBe("t-b");
  });

  test("preserves server order, so the sign-based side anchoring is unaffected", () => {
    const resolved = resolveTransferSides(stalePair(), new TransactionDictionary());
    expect(resolved.map((t) => t.transaction_id)).toEqual(["t-a", "t-b"]);
  });
});
