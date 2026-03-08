/**
 * Merchant name normalization for auto-categorization.
 *
 * Transaction names from Plaid often include store numbers, order IDs,
 * and processor prefixes that prevent matching the same merchant across
 * different transactions. This module normalizes them to a stable form.
 *
 * Design principles:
 *   - Strip only well-known noise patterns (store #s, order IDs, processor prefixes)
 *   - Avoid stripping words that could be part of a brand name
 *   - When in doubt, keep the word — false negatives are safer than false positives
 *
 * Examples:
 *   "STARBUCKS #12345"          → "starbucks"
 *   "STARBUCKS DOWNTOWN"        → "starbucks downtown"
 *   "AMAZON.COM*AB1CD2EF3"      → "amazon.com"
 *   "SQ *BLUE BOTTLE COFFEE"    → "blue bottle coffee"
 *   "PAYPAL *NETFLIX"           → "netflix"
 *   "WHOLEFDS MKT #10417"       → "wholefds mkt"
 */

import { createHash } from "crypto";

/**
 * Processor prefix patterns to remove from the START of transaction names.
 * Applied in order before other transformations.
 */
const PROCESSOR_PREFIXES: RegExp[] = [
  /^SQ\s+\*/i,      // Square: "SQ *MERCHANT"
  /^PAYPAL\s+\*/i,  // PayPal: "PAYPAL *MERCHANT"
  /^TST\*\s*/i,     // Toast: "TST* MERCHANT"
];

/**
 * Patterns to strip anywhere in the name after processor prefix removal.
 */
const NOISE_PATTERNS: RegExp[] = [
  // Store/location numbers: "#12345", "# 12345"
  /\s*#\s*\d+/g,
  // Amazon/processor order IDs: "*AB1CD2EF3GH" (asterisk + 6+ alphanums)
  /\*[A-Z0-9]{4,}/gi,
];

/**
 * Normalize a merchant name to a canonical form for matching.
 *
 * @param name - Raw transaction name from Plaid (e.g. "STARBUCKS #12345")
 * @returns Normalized name (e.g. "starbucks")
 */
export function normalizeMerchantName(name: string | null | undefined): string {
  if (!name) return "";

  let normalized = name.trim();

  // 1. Strip processor prefixes first (order matters)
  for (const pattern of PROCESSOR_PREFIXES) {
    normalized = normalized.replace(pattern, "").trimStart();
  }

  // 2. Strip noise patterns
  for (const pattern of NOISE_PATTERNS) {
    normalized = normalized.replace(pattern, "");
  }

  // 3. Lowercase
  normalized = normalized.toLowerCase();

  // 4. Remove punctuation except hyphens and dots (preserve "amazon.com", "7-eleven")
  normalized = normalized.replace(/[^a-z0-9\s.\-]/g, " ");

  // 5. Collapse multiple spaces and trim
  normalized = normalized.replace(/\s+/g, " ").trim();

  return normalized;
}

/**
 * Generate a stable hash for a normalized merchant name.
 * Used as the primary key in merchant_category_confidence.
 *
 * @param name - Raw transaction name (will be normalized internally)
 * @returns 16-char hex hash of normalized name, or empty string for empty input
 */
export function getMerchantHash(name: string | null | undefined): string {
  const normalized = normalizeMerchantName(name);
  if (!normalized) return "";
  return createHash("sha256").update(normalized).digest("hex").substring(0, 16);
}

/** Confidence threshold: only suggest when confidence exceeds this value */
export const SUGGESTION_CONFIDENCE_THRESHOLD = 0.95;

/**
 * Compute confidence score for a merchant → category mapping.
 *
 * Formula:
 *   base  = accept_count / (accept_count + reject_count)
 *   decay = 0.5 if last_rejected_at < 30 days ago, else 1.0
 *   score = base * decay
 *
 * @param acceptCount - Number of times user confirmed this mapping
 * @param rejectCount - Number of times user rejected this mapping
 * @param lastRejectedAt - Timestamp of most recent rejection (null if never rejected)
 * @returns Confidence score between 0 and 1
 */
export function computeMerchantConfidence(
  acceptCount: number,
  rejectCount: number,
  lastRejectedAt: Date | string | null,
): number {
  const total = acceptCount + rejectCount;
  if (total === 0) return 0;

  const base = acceptCount / total;

  let decay = 1.0;
  if (lastRejectedAt) {
    const rejectedDate =
      typeof lastRejectedAt === "string" ? new Date(lastRejectedAt) : lastRejectedAt;
    const daysSinceRejection = (Date.now() - rejectedDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceRejection < 30) {
      decay = 0.5;
    }
  }

  return base * decay;
}

/**
 * Returns true if the confidence score meets the threshold for showing suggestions.
 */
export function shouldSuggest(
  acceptCount: number,
  rejectCount: number,
  lastRejectedAt: Date | string | null,
): boolean {
  return (
    computeMerchantConfidence(acceptCount, rejectCount, lastRejectedAt) >=
    SUGGESTION_CONFIDENCE_THRESHOLD
  );
}
