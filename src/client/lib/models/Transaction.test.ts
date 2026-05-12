import { describe, test, expect } from "bun:test";
import { isLabelConfirmed } from "./Transaction";

describe("isLabelConfirmed", () => {
  test("unlabeled (no category, no confidence) → not confirmed", () => {
    expect(isLabelConfirmed({ category_id: null, category_confidence: null })).toBe(false);
  });

  test("rejected suggestion (no category, confidence 0) → not confirmed", () => {
    expect(isLabelConfirmed({ category_id: null, category_confidence: 0 })).toBe(false);
  });

  test("auto-suggested unreviewed (category set, 0 < confidence < 1) → not confirmed", () => {
    expect(isLabelConfirmed({ category_id: "cat-1", category_confidence: 0.5 })).toBe(false);
    expect(isLabelConfirmed({ category_id: "cat-1", category_confidence: 0.99 })).toBe(false);
  });

  test("post-Phase-2 user-confirmed (category set, confidence 1) → confirmed", () => {
    expect(isLabelConfirmed({ category_id: "cat-1", category_confidence: 1 })).toBe(true);
  });

  test("legacy user label (category set, confidence null) → confirmed", () => {
    // Population (1): transactions labeled before Phase 2 added the
    // label_category_confidence column; no backfill migration ran, so the
    // confidence sits at NULL. These must NOT show up as unsorted.
    expect(isLabelConfirmed({ category_id: "cat-1", category_confidence: null })).toBe(true);
  });

  test("split transaction shape (category set, confidence undefined) → confirmed", () => {
    // Population (2): split_transactions table has no confidence column at
    // all, so SplitTransactionModel.toJSON() omits the field. After
    // round-trip, SplitTransaction.label.category_confidence is undefined.
    // Splits are not reached by auto-suggest, so a category_id-set split
    // always means "user assigned this".
    expect(isLabelConfirmed({ category_id: "cat-1", category_confidence: undefined })).toBe(true);
    expect(isLabelConfirmed({ category_id: "cat-1" })).toBe(true);
  });

  test("malformed (no category, confidence 1) → not confirmed (defensive)", () => {
    // The sorted-amount branch in getBudgetData does categories.get(category_id)
    // and skips on miss, so a confidence-1-but-no-category row would be
    // dropped entirely. Excluding it from "confirmed" keeps it in the
    // unsorted bucket where it's at least visible.
    expect(isLabelConfirmed({ category_id: null, category_confidence: 1 })).toBe(false);
  });
});
