import { test, expect, describe } from "bun:test";
import type { TransferPair } from "server";
import {
  Data,
  Dictionary,
  ChartDictionary,
  TransactionDictionary,
  InvestmentTransactionDictionary,
  HoldingSnapshotDictionary,
} from "./Data";
import { Chart, Transaction, InvestmentTransaction, HoldingSnapshot } from ".";

// `useMutate` does `data.dictOf(Model).clone()` → mutate → `data.set(dict)`, and
// `Data.set` dispatches on `instanceof <Sub>Dictionary`. So `clone()` MUST return
// the concrete subclass — a base-`Dictionary` clone falls through to `Data.set`'s
// `unknown dictionary` throw, and because that runs inside the `setData` updater
// it surfaces at render. Guard both halves: the clone's class and the round-trip.

describe("Dictionary.clone keeps the concrete subclass", () => {
  const factories = [
    ["ChartDictionary", () => new ChartDictionary(), ChartDictionary],
    ["TransactionDictionary", () => new TransactionDictionary(), TransactionDictionary],
    [
      "InvestmentTransactionDictionary",
      () => new InvestmentTransactionDictionary(),
      InvestmentTransactionDictionary,
    ],
    ["HoldingSnapshotDictionary", () => new HoldingSnapshotDictionary(), HoldingSnapshotDictionary],
  ] as const;

  factories.forEach(([name, make, Ctor]) => {
    test(`${name}.clone() is an instanceof ${name}, not a bare Dictionary`, () => {
      const clone = make().clone();
      expect(clone).toBeInstanceOf(Ctor);
      // A base-Dictionary instance is NOT an instanceof any subclass, so this
      // pins the regression precisely.
      expect(clone.constructor.name).toBe(name);
    });

    test(`Data.set accepts a cloned ${name} without throwing`, () => {
      const data = new Data();
      expect(() => data.set(make().clone())).not.toThrow();
    });
  });

  test("clone copies existing entries", () => {
    const source = new ChartDictionary();
    const chart = new Chart();
    source.set(chart.id, chart);
    const clone = source.clone();
    expect(clone).toBeInstanceOf(ChartDictionary);
    expect(clone.size).toBe(1);
    expect(clone.get(chart.id)).toBe(chart);
  });
});

describe("Data.dictOf → clone → set round-trip (the useMutate flow)", () => {
  test("dictOf returns the concrete subclass for each wired model", () => {
    const data = new Data();
    expect(data.dictOf(Chart)).toBeInstanceOf(ChartDictionary);
    expect(data.dictOf(Transaction)).toBeInstanceOf(TransactionDictionary);
    expect(data.dictOf(InvestmentTransaction)).toBeInstanceOf(InvestmentTransactionDictionary);
    expect(data.dictOf(HoldingSnapshot)).toBeInstanceOf(HoldingSnapshotDictionary);
  });

  test("upsert path: dictOf(Chart).clone() + set lands the instance in data.charts", () => {
    const data = new Data();
    const chart = new Chart();
    const dict: Dictionary = data.dictOf(Chart).clone();
    dict.set(chart.id, chart);
    expect(() => data.set(dict)).not.toThrow();
    expect(data.charts.get(chart.id)).toBe(chart);
  });

  test("delete path: dictOf(Chart).clone() + delete + set evicts from data.charts", () => {
    const data = new Data();
    const chart = new Chart();
    data.charts.set(chart.id, chart);
    const dict: Dictionary = data.dictOf(Chart).clone();
    dict.delete(chart.id);
    expect(() => data.set(dict)).not.toThrow();
    expect(data.charts.has(chart.id)).toBe(false);
  });
});

describe("TransactionDictionary.resolveTransferSides", () => {
  const half = (
    transaction_id: string,
    account_id: string,
    amount: number,
    name: string,
    memo: string,
    city: string,
    authorized_date: string,
  ) => {
    const transaction = new Transaction({
      transaction_id,
      account_id,
      amount,
      name,
      authorized_date,
      label: { memo },
    });
    transaction.location = { ...transaction.location, city };
    return transaction;
  };

  const staleHalf = (transaction_id: string, account_id: string, amount: number) => ({
    ...half(transaction_id, account_id, amount, "old name", "old memo", "Old City", "2026-05-01"),
  });

  const stalePair = (): TransferPair => ({
    pair_id: "p",
    status: "confirmed",
    transactions: [staleHalf("t-a", "acc-out", 10), staleHalf("t-b", "acc-in", -10)],
  });

  const dictWith = (...transactions: Transaction[]) => {
    const dict = new TransactionDictionary();
    transactions.forEach((t) => dict.set(t.transaction_id, t));
    return dict;
  };

  test("reads each half through the authoritative transactions dictionary", () => {
    const [a, b] = dictWith(
      half("t-a", "acc-out", 12.34, "new name", "new memo", "New City", "2026-05-02"),
      half("t-b", "acc-in", -12.34, "new name", "new memo", "New City", "2026-05-02"),
    ).resolveTransferSides(stalePair());

    expect(a.amount).toBe(12.34);
    expect(b.amount).toBe(-12.34);
    expect(a.name).toBe("new name");
    // TransferRow and TransferProperties read the whole half — date, memo and
    // location, not just the edited amount — so every field a rendered row
    // touches has to come from the dictionary copy, not the embedded one.
    expect(a.authorized_date).toBe("2026-05-02");
    expect(a.label?.memo).toBe("new memo");
    expect(a.location?.city).toBe("New City");
  });

  test("falls back to the embedded copy for a half that is not loaded", () => {
    const [a, b] = dictWith(
      half("t-a", "acc-out", 12.34, "new name", "new memo", "New City", "2026-05-02"),
    ).resolveTransferSides(stalePair());

    expect(a.amount).toBe(12.34);
    // t-b is outside the loaded window (or soft-deleted) — the row still
    // renders rather than blanking a side.
    expect(b.amount).toBe(-10);
    expect(b.transaction_id).toBe("t-b");
    expect(b.account_id).toBe("acc-in");
    expect(b.label?.memo).toBe("old memo");
    expect(b.location?.city).toBe("Old City");
  });

  test("preserves server order, so the sign-based side anchoring is unaffected", () => {
    const resolved = new TransactionDictionary().resolveTransferSides(stalePair());
    expect(resolved.map((t) => t.transaction_id)).toEqual(["t-a", "t-b"]);
  });
});
