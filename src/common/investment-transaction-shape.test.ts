import { describe, test, expect } from "bun:test";
import { InvestmentTransactionType, InvestmentTransactionSubtype } from "plaid";
import {
  isCanonical,
  intentOf,
  normalizeShareMovement,
  isNormalizableRow,
  type ShareMovement,
  type IntentField,
} from "./investment-transaction-shape";

const row = (o: Partial<ShareMovement>): ShareMovement => ({
  type: InvestmentTransactionType.Buy,
  subtype: InvestmentTransactionSubtype.Buy,
  quantity: 0,
  price: 0,
  amount: 0,
  ...o,
});

const SIGNS = [-1, 0, 1];
const TYPES = [InvestmentTransactionType.Buy, InvestmentTransactionType.Sell];
const INTENTS: IntentField[] = ["quantity", "type", "price"];

describe("normalizing a hand-entered share movement", () => {
  // Enumerated rather than case-by-case: the editor persists one field group
  // at a time with no cross-field constraint, so every sign combination below
  // is a row someone can actually store. A per-case test pins the cases
  // someone thought of, which is how the shape family stayed open.
  test("every combination a manual write can produce comes out canonical", () => {
    const offenders: string[] = [];

    for (const type of TYPES) {
      for (const qSign of SIGNS) {
        for (const pSign of SIGNS) {
          for (const intent of INTENTS) {
            const input = row({ type, quantity: qSign * 5, price: pSign * 30, amount: -999 });
            const result = normalizeShareMovement(input, intent);
            if (!isCanonical(result)) {
              offenders.push(`${type} q=${input.quantity} p=${input.price} intent=${intent}`);
            }
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test("normalizing an already-canonical row changes nothing", () => {
    const unstable: string[] = [];

    for (const type of TYPES) {
      for (const qSign of SIGNS) {
        for (const pSign of SIGNS) {
          for (const intent of INTENTS) {
            const once = normalizeShareMovement(
              row({ type, quantity: qSign * 5, price: pSign * 30, amount: -999 }),
              intent,
            );
            const twice = normalizeShareMovement(once, intent);
            if (JSON.stringify(once) !== JSON.stringify(twice)) {
              unstable.push(`${type} q=${qSign * 5} p=${pSign * 30} intent=${intent}`);
            }
          }
        }
      }
    }

    expect(unstable).toEqual([]);
  });

  // The two fields pull opposite ways and each is right in its own case, so
  // neither can be authoritative on its own.
  test("a quantity edit decides direction, which is what the reconciliation mint needs", () => {
    const result = normalizeShareMovement(
      row({ type: InvestmentTransactionType.Buy, quantity: -5, price: 30, amount: -150 }),
      "quantity",
    );
    expect(result.type).toBe(InvestmentTransactionType.Sell);
    expect(result.quantity).toBe(-5);
    expect(result.amount).toBeCloseTo(-150, 2);
  });

  test("a type edit decides direction, and corrects a quantity left over from before", () => {
    const result = normalizeShareMovement(
      row({ type: InvestmentTransactionType.Sell, quantity: 5, price: 30, amount: 150 }),
      "type",
    );
    expect(result.quantity).toBe(-5);
    expect(result.amount).toBeCloseTo(-150, 2);
  });

  test("a price edit changes magnitude without moving direction", () => {
    const bought = normalizeShareMovement(
      row({ type: InvestmentTransactionType.Buy, quantity: 10, price: 12, amount: 100 }),
      "price",
    );
    expect(bought.quantity).toBe(10);
    expect(bought.amount).toBeCloseTo(120, 2);

    const sold = normalizeShareMovement(
      row({ type: InvestmentTransactionType.Sell, quantity: -10, price: 12, amount: -100 }),
      "price",
    );
    expect(sold.quantity).toBe(-10);
    expect(sold.amount).toBeCloseTo(-120, 2);
  });

  // The case review warned about: flipping only `type` on a negative amount
  // leaves a sale carrying a negative price, which is a different
  // inconsistent row rather than a consistent one.
  test("a negative price never survives, whichever field carried the intent", () => {
    for (const intent of INTENTS) {
      const result = normalizeShareMovement(
        row({ type: InvestmentTransactionType.Sell, quantity: 5, price: -30, amount: -150 }),
        intent,
      );
      expect(result.price).toBe(30);
      expect(result.amount).toBeCloseTo(result.price * result.quantity, 2);
    }
  });

  test("the intent is the most specific field the write supplied", () => {
    expect(intentOf(["type"])).toBe("type");
    expect(intentOf(["quantity", "amount"])).toBe("quantity");
    expect(intentOf(["price", "amount"])).toBe("price");
    // A write naming both has chosen a direction outright.
    expect(intentOf(["type", "quantity"])).toBe("type");
  });
});

describe("which rows are rewritten at all", () => {
  test("only a hand-entered purchase or sale", () => {
    expect(isNormalizableRow("manual", InvestmentTransactionType.Buy)).toBe(true);
    expect(isNormalizableRow("manual", InvestmentTransactionType.Sell)).toBe(true);
  });

  // One provider mints every movement as a `buy` of one unit priced at the
  // whole amount, signed positive when the money arrives. Rewriting those
  // would turn its withdrawals into deposits.
  test("never a provider row, whatever shape it is in", () => {
    for (const source of ["plaid", "simple_fin", null, undefined]) {
      expect(isNormalizableRow(source, InvestmentTransactionType.Buy)).toBe(false);
      expect(isNormalizableRow(source, InvestmentTransactionType.Sell)).toBe(false);
    }
  });

  // A fee or a cash movement carries its value somewhere `price * quantity`
  // cannot express, so there is nothing here to make consistent.
  test("never a manual row that moves no shares", () => {
    for (const type of [
      InvestmentTransactionType.Cash,
      InvestmentTransactionType.Fee,
      InvestmentTransactionType.Transfer,
      InvestmentTransactionType.Cancel,
    ]) {
      expect(isNormalizableRow("manual", type)).toBe(false);
    }
  });
});
