import { test, expect, describe } from "bun:test";
import { TransactionLabel } from "./Transaction";

// The four suggestion-states from JSONTransactionLabel's field docstring,
// plus the malformed `confidence=1 AND category_id=null` row the calc
// guards against.
const label = (init: Partial<TransactionLabel>) => new TransactionLabel(init);

describe("TransactionLabel.isConfirmed", () => {
  test("true only when confidence is exactly 1 AND a category_id is present", () => {
    expect(label({ category_id: "cat", category_confidence: 1 }).isConfirmed()).toBe(true);
  });

  test("false for the unreviewed suggestion, the rejection, and the never-labeled row", () => {
    expect(label({ category_id: "cat", category_confidence: 0.5 }).isConfirmed()).toBe(false);
    expect(label({ category_id: null, category_confidence: 0 }).isConfirmed()).toBe(false);
    expect(label({}).isConfirmed()).toBe(false);
  });

  test("false for the malformed confidence=1 / category_id=null row (guards categories.get(null))", () => {
    expect(label({ category_id: null, category_confidence: 1 }).isConfirmed()).toBe(false);
  });
});

describe("TransactionLabel.isSuggested", () => {
  test("true only for a category_id with 0 < confidence < 1", () => {
    expect(label({ category_id: "cat", category_confidence: 0.5 }).isSuggested()).toBe(true);
    expect(label({ category_id: "cat", category_confidence: 0.999 }).isSuggested()).toBe(true);
  });

  test("false at the 0 and 1 boundaries (rejected / confirmed, not suggested)", () => {
    expect(label({ category_id: "cat", category_confidence: 0 }).isSuggested()).toBe(false);
    expect(label({ category_id: "cat", category_confidence: 1 }).isSuggested()).toBe(false);
  });

  test("false without a category_id, and for the never-labeled row", () => {
    expect(label({ category_id: null, category_confidence: 0.5 }).isSuggested()).toBe(false);
    expect(label({}).isSuggested()).toBe(false);
  });
});
