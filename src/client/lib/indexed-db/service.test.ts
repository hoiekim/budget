import { test, expect, describe } from "bun:test";
import {
  TransactionDictionary,
  TransferDictionary,
  Dictionary,
  Transaction,
} from "client/lib/models";
import type { TransferPair } from "server";
import { hydrateDictionary } from "./service";

// The regression: loadDictionary used to `new Dictionary() as T`, so anything
// read back from IndexedDB on cold-load was a base Dictionary — every
// subclass-only method (TransferDictionary.byTransactionId, etc.) was
// silently `undefined` at runtime while the type system claimed it was
// present. Pin the fix at the seam where the JSON blob becomes a typed
// instance.

describe("hydrateDictionary preserves the concrete Dictionary subclass", () => {
  test("returns an instance of the passed subclass, not a bare Dictionary", () => {
    const stored = {
      "tx-1": { transaction_id: "tx-1", amount: 5 },
    };
    const dict = hydrateDictionary(stored, TransactionDictionary, Transaction);
    expect(dict).toBeInstanceOf(TransactionDictionary);
    expect(dict.constructor.name).toBe("TransactionDictionary");
    // A base-Dictionary instance is not an instanceof any subclass, so
    // the previous `new Dictionary() as T` would fail this assertion.
    expect(dict instanceof Dictionary).toBe(true);
  });

  test("hydrated values go through the model constructor", () => {
    const stored = {
      "tx-1": { transaction_id: "tx-1", amount: 5 },
    };
    const dict = hydrateDictionary(stored, TransactionDictionary, Transaction);
    expect(dict.size).toBe(1);
    expect(dict.get("tx-1")).toBeInstanceOf(Transaction);
    expect(dict.get("tx-1")?.transaction_id).toBe("tx-1");
  });
});

describe("hydrateDictionary rebuilds TransferDictionary's pivot on cold-load", () => {
  // Identity model — TransferPair is a plain interface, so cold-load
  // feeds the stored blob straight into the dictionary constructor.
  class TransferPairModel {
    pair_id!: string;
    status!: TransferPair["status"];
    transactions!: TransferPair["transactions"];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(json: any) {
      Object.assign(this, json);
    }
  }

  const makePair = (
    pair_id: string,
    status: TransferPair["status"],
    transaction_ids: [string, string],
  ): TransferPair => ({
    pair_id,
    status,
    transactions: transaction_ids.map((id) => ({ transaction_id: id }) as never),
  });

  test("byTransactionId accessors resolve halves after a cold-load hydrate", () => {
    const stored = {
      conf: makePair("conf", "confirmed", ["c1", "c2"]),
      sugg: makePair("sugg", "suggested", ["s1", "s2"]),
    };
    // The TransferDictionary constructor rebuilds the pivot from the
    // entries the base Map constructor just ingested.
    const dict = hydrateDictionary(
      stored,
      TransferDictionary,
      TransferPairModel as unknown as new (json: unknown) => TransferPair,
    );
    expect(dict).toBeInstanceOf(TransferDictionary);
    expect(typeof dict.byTransactionId?.get).toBe("function");
    expect(dict.byTransactionId.get("c1")?.pair_id).toBe("conf");
    expect(dict.byTransactionId.hasConfirmed("c1")).toBe(true);
    expect(dict.byTransactionId.hasSuggested("s1")).toBe(true);
    expect(dict.byTransactionId.has("nope")).toBe(false);
  });
});
