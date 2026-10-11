import { describe, test, expect } from "bun:test";
import { InvestmentTransactionType } from "plaid";
import {
  isCanonical,
  movesShares,
  normalizeShareMovement,
  shapePatchFor,
  isNormalizableRow,
  type ShareMovement,
  type IntentField,
} from "./investment-transaction-shape";

const row = (o: Partial<ShareMovement>): ShareMovement => ({
  type: InvestmentTransactionType.Buy,
  quantity: 0,
  price: 0,
  amount: 0,
  ...o,
});

const SIGNS = [-1, 0, 1];
// Every type the editor's dropdown offers, not only the two this reconciles.
// Enumerating the inputs the rule expects rather than the ones the UI can
// produce is how a pick of Cash came to be stored as a sale.
const TYPES = Object.values(InvestmentTransactionType);
const SHARE_TYPES = [InvestmentTransactionType.Buy, InvestmentTransactionType.Sell];
const INTENTS: IntentField[] = ["quantity", "type", "price"];

describe("normalizing a hand-entered share movement", () => {
  // Enumerated rather than case-by-case: the editor persists one field group
  // at a time with no cross-field constraint, so every sign combination below
  // is a row someone can actually store. A per-case test pins the cases
  // someone thought of, which is how the shape family stayed open.
  test("every combination a manual write can produce comes out canonical", () => {
    const offenders: string[] = [];

    for (const type of SHARE_TYPES) {
      for (const qSign of SIGNS) {
        for (const pSign of SIGNS) {
          for (const intent of INTENTS) {
            const input = row({ type, quantity: qSign * 5, price: pSign * 30, amount: -999 });
            const result = normalizeShareMovement(input, intent);
            // The direction the edit meant, not merely a self-consistent one:
            // both {buy, +5} and {sell, -5} agree with themselves.
            const meant =
              intent === "type"
                ? type === InvestmentTransactionType.Buy
                : intent === "quantity"
                  ? qSign >= 0
                  : qSign !== 0
                    ? qSign > 0
                    : type === InvestmentTransactionType.Buy;
            if (!isCanonical(result, meant)) {
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

    for (const type of SHARE_TYPES) {
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

  // The dropdown offers six types and this rule speaks for two. A caller
  // handing it one of the other four gets a sale, which is why the caller
  // has to ask `movesShares` first rather than this silently coping.
  test("only a purchase and a sale are types this rule can speak for", () => {
    const covered = TYPES.filter((type) => movesShares(type));
    expect(covered).toEqual(SHARE_TYPES);
    expect(TYPES.filter((type) => !movesShares(type))).toHaveLength(4);
  });

  // A price edit must not move direction. Both readings agree on an already
  // canonical row, so the fixture has to start uncanonical to see it.
  test("a price edit keeps the direction the quantity already had", () => {
    const result = normalizeShareMovement(
      row({ type: InvestmentTransactionType.Sell, quantity: 5, price: 30, amount: -150 }),
      "price",
    );
    expect(result.type).toBe(InvestmentTransactionType.Buy);
    expect(result.quantity).toBe(5);
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

// The editor's whole decision, reachable without rendering it. The gate here
// is what keeps a picked type from being replaced by a sale.
describe("the patch a single edit writes", () => {
  const canonicalBuy: ShareMovement = {
    type: InvestmentTransactionType.Buy,
    quantity: 5,
    price: 30,
    amount: 150,
  };

  test("picking a type that moves no shares stores that type, not a sale", () => {
    for (const type of TYPES.filter((t) => !movesShares(t))) {
      const patch = shapePatchFor(canonicalBuy, "type", { type });
      expect(patch.type).toBe(type);
      expect(patch).not.toHaveProperty("quantity");
    }
  });

  test("editing a number on a row that moves no shares leaves its type alone", () => {
    const cashRow: ShareMovement = {
      type: InvestmentTransactionType.Fee,
      quantity: 1,
      price: 25,
      amount: 25,
    };

    const patch = shapePatchFor(cashRow, "price", { price: 40 });
    expect(patch).not.toHaveProperty("type");
    expect(patch.price).toBe(40);
  });

  test("picking Sell corrects the quantity and the amount with it", () => {
    const patch = shapePatchFor(canonicalBuy, "type", {
      type: InvestmentTransactionType.Sell,
    });
    expect(patch.type).toBe(InvestmentTransactionType.Sell);
    expect(patch.quantity).toBe(-5);
    expect(patch.amount).toBeCloseTo(-150, 2);
  });

  test("a negative quantity is stored as a sale", () => {
    const patch = shapePatchFor(canonicalBuy, "quantity", { quantity: -4 });
    expect(patch.type).toBe(InvestmentTransactionType.Sell);
    expect(patch.quantity).toBe(-4);
    expect(patch.amount).toBeCloseTo(-120, 2);
  });

  test("a field the edit agrees with is not written", () => {
    const patch = shapePatchFor(canonicalBuy, "price", { price: 40 });
    expect(patch).not.toHaveProperty("type");
    expect(patch).not.toHaveProperty("quantity");
    expect(patch.price).toBe(40);
    expect(patch.amount).toBeCloseTo(200, 2);
  });

  test("an edit that changes nothing writes nothing", () => {
    expect(shapePatchFor(canonicalBuy, "price", { price: 30 })).toEqual({});
  });
});
