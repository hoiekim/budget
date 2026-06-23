import { test, expect, describe } from "bun:test";
import type { TransferPair } from "server";
import { TransferDictionary } from "./Data";

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
