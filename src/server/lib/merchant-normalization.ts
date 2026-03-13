/**
 * ML-based merchant name normalization using TF-IDF token frequency analysis.
 *
 * Instead of hardcoded patterns, this module learns which tokens are "noise"
 * from your actual transaction data:
 *   - Tokens appearing in a very high proportion of distinct transaction names
 *     are universal noise (punctuation fragments, lone digits, etc.)
 *   - Tokens that appear very rarely AND look like order IDs / confirmation codes
 *     (mixed letters + digits, length ≥ 5) are transaction-specific noise.
 *   - Everything else is considered meaningful and kept.
 *
 * Merchant similarity is computed with Jaccard similarity on normalized token sets,
 * enabling deduplication without any hardcoded merchant names.
 */

import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Token model
// ---------------------------------------------------------------------------

export interface TokenModel {
  /** token → number of distinct transaction names that contain it */
  documentFrequencies: Map<string, number>;
  /** Total distinct transaction names used to build this model */
  totalDocuments: number;
}

/**
 * Build a token frequency model from an array of distinct transaction names.
 *
 * Call this once at startup (or whenever new transactions arrive) with all
 * transaction names for a given user, then pass the result to
 * `normalizeMerchantName` / `getMerchantHash`.
 *
 * @param transactionNames - Array of raw transaction name strings
 * @returns TokenModel with document frequencies and document count
 */
export function buildTokenModel(transactionNames: string[]): TokenModel {
  const documentFrequencies = new Map<string, number>();

  for (const name of transactionNames) {
    const uniqueTokens = new Set(tokenize(name));
    for (const token of uniqueTokens) {
      documentFrequencies.set(token, (documentFrequencies.get(token) ?? 0) + 1);
    }
  }

  return { documentFrequencies, totalDocuments: transactionNames.length };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Split a raw transaction name into lowercase alphanumeric tokens.
 * Dots are preserved inside tokens (e.g. "amazon.com" stays intact).
 */
function tokenize(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter((t) => t.length > 0);
}

/**
 * Return true if a token should be treated as noise given the learned model.
 *
 * Rules (in order):
 *   1. Pure numeric ("12345") — always noise (store #s, zip codes, etc.)
 *   2. Single character — noise from punctuation splitting
 *   3. Mixed alpha-numeric, length ≥ 5, appears in < 2% of documents
 *      → transaction-specific order ID / confirmation code (e.g. "AB1CD2EF3")
 *
 * Note: tokens that appear in a high proportion of the corpus are NOT treated as
 * noise — if a user has many Amazon transactions, "amazon" is the merchant name,
 * not noise.
 */
function isNoiseToken(token: string, model: TokenModel): boolean {
  // 1. Pure numeric
  if (/^\d+$/.test(token)) return true;

  // 2. Single character
  if (token.length === 1) return true;

  const df = model.documentFrequencies.get(token) ?? 0;
  const relDF = model.totalDocuments > 0 ? df / model.totalDocuments : 0;

  // 3. Order-ID-like token: mixed letters + digits, length ≥ 5, very rare in corpus
  if (token.length >= 5 && /[0-9]/.test(token) && /[a-z]/.test(token) && relDF < 0.02) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Normalize a merchant name using a learned token model.
 *
 * When no model is supplied (e.g. for new users with no transaction history),
 * falls back to basic tokenization: lowercase, drop pure-numeric tokens and
 * single characters.
 *
 * @param name  - Raw transaction name from Plaid
 * @param model - TokenModel built via `buildTokenModel` (optional)
 * @returns Normalized name as space-joined tokens, or "" for empty input
 */
export function normalizeMerchantName(
  name: string | null | undefined,
  model?: TokenModel,
): string {
  if (!name) return "";

  const tokens = tokenize(name);

  if (!model || model.totalDocuments === 0) {
    // No model yet — basic fallback: drop pure numerics and single chars
    const kept = tokens.filter((t) => t.length > 1 && !/^\d+$/.test(t));
    return kept.join(" ").trim();
  }

  const meaningful = tokens.filter((t) => !isNoiseToken(t, model));

  if (meaningful.length === 0) {
    // All tokens were noise — fall back to the two longest non-numeric tokens
    const fallback = tokens
      .filter((t) => !/^\d+$/.test(t))
      .sort((a, b) => b.length - a.length)
      .slice(0, 2);
    return fallback.join(" ").trim();
  }

  return meaningful.join(" ").trim();
}

/**
 * Compute Jaccard similarity between two raw merchant names.
 *
 * Similarity = |A ∩ B| / |A ∪ B|  where A, B are normalized token sets.
 * Returns a score in [0, 1] — 1.0 means identical token sets, 0.0 means
 * no overlap.
 *
 * @param nameA  - First raw transaction name
 * @param nameB  - Second raw transaction name
 * @param model  - Optional TokenModel for noise-aware normalization
 */
export function merchantSimilarity(
  nameA: string,
  nameB: string,
  model?: TokenModel,
): number {
  const setA = new Set(tokenize(normalizeMerchantName(nameA, model)));
  const setB = new Set(tokenize(normalizeMerchantName(nameB, model)));

  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

/**
 * Generate a stable 16-char hex hash for a merchant name.
 * Used as the primary key in `merchant_category_confidence`.
 *
 * @param name  - Raw transaction name (normalized internally)
 * @param model - Optional TokenModel for noise-aware normalization
 * @returns 16-char hex hash, or "" for empty/null input
 */
export function getMerchantHash(
  name: string | null | undefined,
  model?: TokenModel,
): string {
  const normalized = normalizeMerchantName(name, model);
  if (!normalized) return "";
  return createHash("sha256").update(normalized).digest("hex").substring(0, 16);
}

// ---------------------------------------------------------------------------
// Confidence scoring (unchanged)
// ---------------------------------------------------------------------------

/** Confidence threshold: only suggest when score ≥ this value */
export const SUGGESTION_CONFIDENCE_THRESHOLD = 0.95;

/**
 * Compute confidence score for a merchant → category mapping.
 *
 * Formula:
 *   base  = accept_count / (accept_count + reject_count)
 *   decay = 0.5 if last_rejected_at < 30 days ago, else 1.0
 *   score = base × decay
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
 * Returns true if the confidence score meets the suggestion threshold.
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
