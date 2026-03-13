import { describe, it, expect } from "bun:test";
import {
  buildTokenModel,
  normalizeMerchantName,
  getMerchantHash,
  merchantSimilarity,
  computeMerchantConfidence,
  shouldSuggest,
  SUGGESTION_CONFIDENCE_THRESHOLD,
} from "./merchant-normalization";

// ---------------------------------------------------------------------------
// buildTokenModel
// ---------------------------------------------------------------------------

describe("buildTokenModel", () => {
  it("counts document frequencies correctly", () => {
    const model = buildTokenModel(["STARBUCKS #123", "STARBUCKS #456", "NETFLIX"]);
    // "starbucks" appears in 2 of 3 documents
    expect(model.documentFrequencies.get("starbucks")).toBe(2);
    // "netflix" appears in 1 document
    expect(model.documentFrequencies.get("netflix")).toBe(1);
    // "123" appears in 1 document
    expect(model.documentFrequencies.get("123")).toBe(1);
    expect(model.totalDocuments).toBe(3);
  });

  it("counts each token once per document (not per occurrence)", () => {
    // "foo foo foo" — "foo" appears once in the document
    const model = buildTokenModel(["FOO FOO FOO"]);
    expect(model.documentFrequencies.get("foo")).toBe(1);
    expect(model.totalDocuments).toBe(1);
  });

  it("handles empty array", () => {
    const model = buildTokenModel([]);
    expect(model.totalDocuments).toBe(0);
    expect(model.documentFrequencies.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// normalizeMerchantName — no model (fallback)
// ---------------------------------------------------------------------------

describe("normalizeMerchantName (no model)", () => {
  it("lowercases and tokenizes", () => {
    expect(normalizeMerchantName("NETFLIX")).toBe("netflix");
    expect(normalizeMerchantName("Whole Foods Market")).toBe("whole foods market");
  });

  it("drops pure-numeric tokens", () => {
    // "12345" is pure numeric — dropped
    expect(normalizeMerchantName("STARBUCKS 12345")).toBe("starbucks");
  });

  it("drops single-character tokens", () => {
    expect(normalizeMerchantName("A NETFLIX B")).toBe("netflix");
  });

  it("preserves dots in tokens", () => {
    expect(normalizeMerchantName("AMAZON.COM")).toBe("amazon.com");
  });

  it("returns empty string for null/undefined/empty", () => {
    expect(normalizeMerchantName(null)).toBe("");
    expect(normalizeMerchantName(undefined)).toBe("");
    expect(normalizeMerchantName("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// normalizeMerchantName — with model
// ---------------------------------------------------------------------------

describe("normalizeMerchantName (with model)", () => {
  it("drops numeric tokens (store numbers)", () => {
    // Build a model where "starbucks" appears often, numbers are pure-numeric noise
    const names = Array.from({ length: 20 }, (_, i) => `STARBUCKS #${1000 + i}`);
    const model = buildTokenModel(names);
    // "#" and numeric tokens should be noise
    const result = normalizeMerchantName("STARBUCKS #99999", model);
    expect(result).toBe("starbucks");
  });

  it("normalizes same merchant with different store numbers to same result", () => {
    const names = Array.from({ length: 20 }, (_, i) => `STARBUCKS #${1000 + i}`);
    const model = buildTokenModel(names);
    const a = normalizeMerchantName("STARBUCKS #12345", model);
    const b = normalizeMerchantName("STARBUCKS #99999", model);
    expect(a).toBe(b);
    expect(a).toBe("starbucks");
  });

  it("drops order-ID-like tokens (mixed alpha-digit, rare, long)", () => {
    // "AB1CD2EF3" appears in only 1 of 100 transaction names → rare mixed token (<2% DF)
    const names = [
      "AMAZON.COM AB1CD2EF3",
      ...Array.from({ length: 99 }, () => "AMAZON.COM"),
    ];
    const model = buildTokenModel(names);
    const result = normalizeMerchantName("AMAZON.COM AB1CD2EF3", model);
    expect(result).not.toContain("ab1cd2ef3");
    expect(result).toContain("amazon.com");
  });

  it("preserves high-frequency tokens that are the actual merchant name", () => {
    // "amazon.com" appearing in many transactions is the merchant name, not noise
    const names = Array.from({ length: 50 }, () => "AMAZON.COM");
    const model = buildTokenModel(names);
    const result = normalizeMerchantName("AMAZON.COM", model);
    expect(result).toBe("amazon.com");
  });

  it("keeps meaningful multi-word names", () => {
    // Neither "whole" nor "foods" nor "market" should be noise in a normal corpus
    const names = [
      "WHOLE FOODS MARKET",
      "STARBUCKS",
      "NETFLIX",
      "AMAZON.COM",
      "TARGET",
    ];
    const model = buildTokenModel(names);
    const result = normalizeMerchantName("WHOLE FOODS MARKET", model);
    expect(result).toBe("whole foods market");
  });

  it("falls back to longest non-numeric tokens when all tokens are noise", () => {
    // Model with everything as universal noise would be degenerate, but
    // normalizeMerchantName should not return empty string in that edge case
    const names = Array.from({ length: 20 }, (_, i) => `MERCHANT${i}`);
    const model = buildTokenModel(names);
    // "amazon" appears in none of the model names → not in frequencies
    // No tokens should qualify as noise here since none exceed 95% DF
    const result = normalizeMerchantName("AMAZON 12345", model);
    // "12345" is pure numeric noise; "amazon" is not in model → DF=0 → relDF=0
    // isNoiseToken("amazon"): not pure numeric, not single char, not order-ID-like, relDF=0 < 0.95
    expect(result).toContain("amazon");
  });

  it("returns empty string for null/undefined/empty regardless of model", () => {
    const model = buildTokenModel(["STARBUCKS", "NETFLIX"]);
    expect(normalizeMerchantName(null, model)).toBe("");
    expect(normalizeMerchantName(undefined, model)).toBe("");
    expect(normalizeMerchantName("", model)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// merchantSimilarity
// ---------------------------------------------------------------------------

describe("merchantSimilarity", () => {
  it("returns 1.0 for identical names", () => {
    expect(merchantSimilarity("STARBUCKS", "STARBUCKS")).toBe(1);
  });

  it("returns 0.0 for completely different names", () => {
    expect(merchantSimilarity("STARBUCKS", "NETFLIX")).toBe(0);
  });

  it("returns partial similarity for overlapping tokens", () => {
    // "whole foods market" vs "whole foods" → 2/3 = 0.667
    const sim = merchantSimilarity("WHOLE FOODS MARKET", "WHOLE FOODS");
    expect(sim).toBeCloseTo(2 / 3, 5);
  });

  it("matches same merchant with different store numbers using model", () => {
    const names = Array.from({ length: 30 }, (_, i) => `STARBUCKS #${1000 + i}`);
    const model = buildTokenModel(names);
    const sim = merchantSimilarity("STARBUCKS #12345", "STARBUCKS #99999", model);
    // After normalization both → "starbucks", Jaccard = 1.0
    expect(sim).toBe(1);
  });

  it("returns 1.0 for two empty names", () => {
    expect(merchantSimilarity("", "")).toBe(1);
  });

  it("returns 0.0 when one side is empty", () => {
    expect(merchantSimilarity("STARBUCKS", "")).toBe(0);
    expect(merchantSimilarity("", "NETFLIX")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getMerchantHash
// ---------------------------------------------------------------------------

describe("getMerchantHash", () => {
  it("returns same hash for same merchant with different store numbers (with model)", () => {
    const names = Array.from({ length: 20 }, (_, i) => `STARBUCKS #${1000 + i}`);
    const model = buildTokenModel(names);
    const h1 = getMerchantHash("STARBUCKS #12345", model);
    const h2 = getMerchantHash("STARBUCKS #99999", model);
    expect(h1).toBe(h2);
  });

  it("returns different hashes for different merchants", () => {
    const h1 = getMerchantHash("STARBUCKS");
    const h2 = getMerchantHash("DUNKIN");
    expect(h1).not.toBe(h2);
  });

  it("returns empty string for empty input", () => {
    expect(getMerchantHash(null)).toBe("");
    expect(getMerchantHash("")).toBe("");
  });

  it("returns a 16-character hex string", () => {
    const hash = getMerchantHash("NETFLIX");
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });
});

// ---------------------------------------------------------------------------
// computeMerchantConfidence
// ---------------------------------------------------------------------------

describe("computeMerchantConfidence", () => {
  it("returns 0 with no observations", () => {
    expect(computeMerchantConfidence(0, 0, null)).toBe(0);
  });

  it("returns 1.0 with all accepts and no rejection history", () => {
    expect(computeMerchantConfidence(10, 0, null)).toBe(1.0);
  });

  it("applies 0.5 decay with a recent rejection", () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    expect(computeMerchantConfidence(10, 0, yesterday)).toBe(0.5);
  });

  it("does not apply decay for rejection older than 30 days", () => {
    const twoMonthsAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    expect(computeMerchantConfidence(10, 0, twoMonthsAgo)).toBe(1.0);
  });

  it("factors in reject count in base score", () => {
    expect(computeMerchantConfidence(9, 1, null)).toBeCloseTo(0.9);
  });

  it("accepts ISO string date for lastRejectedAt", () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    expect(computeMerchantConfidence(10, 0, yesterday)).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// shouldSuggest
// ---------------------------------------------------------------------------

describe("shouldSuggest", () => {
  it(`returns true when confidence >= ${SUGGESTION_CONFIDENCE_THRESHOLD}`, () => {
    expect(shouldSuggest(20, 0, null)).toBe(true);
  });

  it("returns false when confidence < threshold", () => {
    expect(shouldSuggest(9, 1, null)).toBe(false);
  });

  it("returns false when recent rejection decays confidence below threshold", () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    expect(shouldSuggest(10, 0, yesterday)).toBe(false);
  });

  it("returns true when old rejection does not decay confidence", () => {
    const twoMonthsAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    expect(shouldSuggest(20, 0, twoMonthsAgo)).toBe(true);
  });
});
