import { test, expect, describe } from "bun:test";
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
