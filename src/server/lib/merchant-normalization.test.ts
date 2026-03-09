import { describe, it, expect } from "bun:test";
import {
  normalizeMerchantName,
  getMerchantHash,
  computeMerchantConfidence,
  shouldSuggest,
  SUGGESTION_CONFIDENCE_THRESHOLD,
} from "./merchant-normalization";

describe("normalizeMerchantName", () => {
  it("strips store numbers", () => {
    expect(normalizeMerchantName("STARBUCKS #12345")).toBe("starbucks");
    expect(normalizeMerchantName("WHOLEFDS MKT #10417")).toBe("wholefds mkt");
    expect(normalizeMerchantName("TARGET # 42")).toBe("target");
  });

  it("strips Amazon-style order IDs after asterisk", () => {
    expect(normalizeMerchantName("AMAZON.COM*AB1CD2EF3")).toBe("amazon.com");
    expect(normalizeMerchantName("AMZN*1A2B3C4D")).toBe("amzn");
  });

  it("strips Square prefix", () => {
    expect(normalizeMerchantName("SQ *BLUE BOTTLE COFFEE")).toBe("blue bottle coffee");
    expect(normalizeMerchantName("SQ *BLUE BOTTLE COFFEE #5")).toBe("blue bottle coffee");
  });

  it("strips PayPal prefix", () => {
    expect(normalizeMerchantName("PAYPAL *NETFLIX")).toBe("netflix");
  });

  it("strips Toast prefix", () => {
    expect(normalizeMerchantName("TST* LOCAL CAFE")).toBe("local cafe");
  });

  it("lowercases the result", () => {
    expect(normalizeMerchantName("NETFLIX")).toBe("netflix");
    expect(normalizeMerchantName("Whole Foods Market")).toBe("whole foods market");
  });

  it("preserves brand words that look like location names", () => {
    // "DOWNTOWN", "MARKET", "STORE" should NOT be stripped when part of brand
    expect(normalizeMerchantName("STARBUCKS DOWNTOWN")).toBe("starbucks downtown");
    expect(normalizeMerchantName("WHOLE FOODS MARKET")).toBe("whole foods market");
  });

  it("normalizes same merchant with different store numbers to same result", () => {
    const a = normalizeMerchantName("STARBUCKS #12345");
    const b = normalizeMerchantName("STARBUCKS #99999");
    expect(a).toBe(b);
    expect(a).toBe("starbucks");
  });

  it("handles null/undefined/empty", () => {
    expect(normalizeMerchantName(null)).toBe("");
    expect(normalizeMerchantName(undefined)).toBe("");
    expect(normalizeMerchantName("")).toBe("");
  });

  it("preserves dots and hyphens", () => {
    expect(normalizeMerchantName("7-ELEVEN")).toBe("7-eleven");
    expect(normalizeMerchantName("AMAZON.COM")).toBe("amazon.com");
  });

  it("collapses multiple spaces", () => {
    expect(normalizeMerchantName("SOME   STORE")).toBe("some store");
  });

  it("removes special characters except hyphens and dots", () => {
    // & is replaced by space, then spaces are collapsed
    expect(normalizeMerchantName("ACME & CO")).toBe("acme co");
  });
});

describe("getMerchantHash", () => {
  it("returns same hash for same merchant with different store numbers", () => {
    const h1 = getMerchantHash("STARBUCKS #12345");
    const h2 = getMerchantHash("STARBUCKS #99999");
    expect(h1).toBe(h2);
  });

  it("returns different hashes for different merchants", () => {
    const h1 = getMerchantHash("STARBUCKS");
    const h2 = getMerchantHash("DUNKIN DONUTS");
    expect(h1).not.toBe(h2);
  });

  it("returns empty string for empty input", () => {
    expect(getMerchantHash(null)).toBe("");
    expect(getMerchantHash("")).toBe("");
  });

  it("returns 16 character hex string", () => {
    const hash = getMerchantHash("NETFLIX");
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });
});

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
    // 9 accepts, 1 reject = 0.9 base, no decay
    expect(computeMerchantConfidence(9, 1, null)).toBeCloseTo(0.9);
  });

  it("accepts string date for lastRejectedAt", () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    expect(computeMerchantConfidence(10, 0, yesterday)).toBe(0.5);
  });
});

describe("shouldSuggest", () => {
  it(`returns true when confidence >= ${SUGGESTION_CONFIDENCE_THRESHOLD}`, () => {
    // 20 accepts, 0 rejects, no rejection = 1.0 confidence
    expect(shouldSuggest(20, 0, null)).toBe(true);
  });

  it("returns false when confidence < threshold", () => {
    // 9 accepts, 1 reject = 0.9 confidence (below 0.95)
    expect(shouldSuggest(9, 1, null)).toBe(false);
  });

  it("returns false when recent rejection decays confidence below threshold", () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    // 10 accepts, no rejects, recent rejection: 1.0 * 0.5 = 0.5
    expect(shouldSuggest(10, 0, yesterday)).toBe(false);
  });

  it("returns true when old rejection does not decay confidence", () => {
    const twoMonthsAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    expect(shouldSuggest(20, 0, twoMonthsAgo)).toBe(true);
  });
});
