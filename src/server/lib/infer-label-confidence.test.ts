import { describe, it, expect } from "bun:test";
import { inferLabelConfidence } from "./infer-label-confidence";

// Generic helper that maps user intent (expressed as { category_id?, confidence? }
// on the request body's label) to a concrete confidence value before the row
// hits the repo. Mirror the contract described in the helper's docstring.

describe("inferLabelConfidence", () => {
  it("no label → returns input unchanged", () => {
    const tx = { transaction_id: "txn-1" };
    expect(inferLabelConfidence(tx)).toBe(tx);
  });

  it("label without category_id property → no-op (caller didn't touch category)", () => {
    const tx = { transaction_id: "txn-1", label: { budget_id: "bud-1" } };
    const out = inferLabelConfidence(tx);
    expect(out.label).toEqual({ budget_id: "bud-1" });
    expect("category_confidence" in out.label!).toBe(false);
  });

  it("category_id set + confidence undefined → confidence = 1 (user-confirmed)", () => {
    const out = inferLabelConfidence({
      transaction_id: "txn-1",
      label: { category_id: "cat-1" },
    });
    expect(out.label).toEqual({ category_id: "cat-1", category_confidence: 1 });
  });

  it("category_id null + confidence undefined → confidence = 0 (rejection signal)", () => {
    // This is the gap the previous repo-layer helper missed: a budget-change
    // path that clears category should be treated as a rejection so the
    // auto-suggest engine doesn't re-suggest the same thing on the next
    // hourly run (engine filter is `confidence IS NULL`).
    const out = inferLabelConfidence({
      transaction_id: "txn-1",
      label: { budget_id: "bud-1", category_id: null },
    });
    expect(out.label).toEqual({
      budget_id: "bud-1",
      category_id: null,
      category_confidence: 0,
    });
  });

  it("category_id set + confidence explicitly set → preserve caller's value", () => {
    const out = inferLabelConfidence({
      transaction_id: "txn-1",
      label: { category_id: "cat-1", category_confidence: 0.99 },
    });
    expect(out.label?.category_confidence).toBe(0.99);
  });

  it("category_id null + confidence explicitly 0 → preserve caller's value (idempotent)", () => {
    const out = inferLabelConfidence({
      transaction_id: "txn-1",
      label: { category_id: null, category_confidence: 0 },
    });
    expect(out.label?.category_confidence).toBe(0);
  });

  it("does not mutate the input", () => {
    const tx = { transaction_id: "txn-1", label: { category_id: "cat-1" } };
    const before = JSON.stringify(tx);
    inferLabelConfidence(tx);
    expect(JSON.stringify(tx)).toBe(before);
  });

  it("works generically — accepts split-transaction shapes", () => {
    const split = {
      split_transaction_id: "split-1",
      label: { category_id: "cat-1" },
    };
    const out = inferLabelConfidence(split);
    expect(out).toMatchObject({
      split_transaction_id: "split-1",
      label: { category_id: "cat-1", category_confidence: 1 },
    });
  });
});
