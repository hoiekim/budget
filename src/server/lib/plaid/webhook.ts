import * as jose from "jose";
import { getProductionClient } from "./util";
import { logger } from "../logger";
import { plaidKeyFetchRateLimiter } from "../rate-limit";

const KEY_CACHE_TTL = 1000 * 60 * 60; // 1 hour
export const UNKNOWN_KEY_CACHE_TTL = 1000 * 60 * 5;
const KEY_FETCH_BUCKET = "global";
const KNOWN_KEY_LIMIT = 100;

/**
 * What verifying a webhook concluded. `unverifiable` means the answer couldn't
 * be reached (the key couldn't be fetched just now), which the route answers
 * with a status Plaid retries. Plaid treats a 401 as permanent, so only
 * `invalid` gets one.
 */
export type WebhookVerification = "valid" | "invalid" | "unverifiable";

/** A key, Plaid's word that no such key exists, or no answer yet. */
export type KeyLookupResult = jose.JWK | "unknown" | "unavailable";

/** Plaid's answer for a key_id it has never issued. */
const isUnknownKeyError = (error: unknown): boolean =>
  (error as { response?: { data?: { error_code?: string } } })?.response?.data?.error_code ===
  "INVALID_WEBHOOK_VERIFICATION_KEY_ID";

/**
 * Builds a verification-key lookup around `fetchKey`.
 *
 * - A key is cached for an hour.
 * - A key_id Plaid says doesn't exist is cached as unknown for five minutes.
 *   Any other fetch error is not cached, so the next webhook asks again.
 * - Concurrent lookups of one key_id share a fetch.
 * - Fetches of key_ids that have never verified are capped process-wide by
 *   `plaidKeyFetchRateLimiter`; over the cap the answer is `unavailable`. A
 *   key_id that has verified before skips the cap when its cache expires, so a
 *   flood of made-up key_ids can't block the keys Plaid actually signs with.
 */
export const createVerificationKeyLookup = (fetchKey: (keyId: string) => Promise<jose.JWK>) => {
  const keyCache = new Map<string, { key: jose.JWK | "unknown"; fetchedAt: number }>();
  const inflightKeys = new Map<string, Promise<KeyLookupResult>>();
  const knownKeyIds = new Set<string>();
  const ttlOf = (entry: { key: jose.JWK | "unknown" }) =>
    entry.key === "unknown" ? UNKNOWN_KEY_CACHE_TTL : KEY_CACHE_TTL;

  // Periodically evict stale key cache entries to prevent unbounded growth.
  setInterval(() => {
    const now = Date.now();
    for (const [keyId, entry] of keyCache) {
      if (now - entry.fetchedAt >= ttlOf(entry)) keyCache.delete(keyId);
    }
  }, UNKNOWN_KEY_CACHE_TTL).unref();

  const remember = (keyId: string) => {
    knownKeyIds.delete(keyId);
    knownKeyIds.add(keyId);
    if (knownKeyIds.size > KNOWN_KEY_LIMIT) knownKeyIds.delete(knownKeyIds.values().next().value!);
  };

  const fetchAndCache = async (keyId: string): Promise<KeyLookupResult> => {
    try {
      const key = await fetchKey(keyId);
      keyCache.set(keyId, { key, fetchedAt: Date.now() });
      remember(keyId);
      return key;
    } catch (error) {
      if (isUnknownKeyError(error)) {
        keyCache.set(keyId, { key: "unknown", fetchedAt: Date.now() });
        return "unknown";
      }
      logger.error("Failed to fetch verification key", { component: "plaid.webhook" }, error);
      return "unavailable";
    }
  };

  return async (keyId: string): Promise<KeyLookupResult> => {
    const cached = keyCache.get(keyId);
    if (cached && Date.now() - cached.fetchedAt < ttlOf(cached)) return cached.key;

    const inflight = inflightKeys.get(keyId);
    if (inflight) return inflight;

    if (!knownKeyIds.has(keyId)) {
      if (plaidKeyFetchRateLimiter.isLimited(KEY_FETCH_BUCKET)) return "unavailable";
      plaidKeyFetchRateLimiter.consume(KEY_FETCH_BUCKET);
    }

    const fetching = fetchAndCache(keyId);
    inflightKeys.set(keyId, fetching);
    // Removed once settled, never before it is registered, even when the fetch fails synchronously.
    void fetching.finally(() => inflightKeys.delete(keyId));
    return fetching;
  };
};

// Webhooks only come from production - always use production client
const getVerificationKey = createVerificationKeyLookup(
  async (keyId) =>
    (await getProductionClient().webhookVerificationKeyGet({ key_id: keyId })).data.key as jose.JWK,
);

/**
 * Verify a Plaid webhook request.
 *
 * Plaid signs webhooks with a JWT in the Plaid-Verification header.
 * This function validates the JWT signature using Plaid's public keys.
 *
 * @param body - The raw request body as a string
 * @param signedJwt - The Plaid-Verification header value
 * @param lookupKey - Where verification keys come from; tests pass their own
 */
export const verifyWebhook = async (
  body: string,
  signedJwt: string | undefined,
  lookupKey: (keyId: string) => Promise<KeyLookupResult> = getVerificationKey,
): Promise<WebhookVerification> => {
  if (!signedJwt) {
    logger.warn("Missing Plaid-Verification header", { component: "plaid.webhook" });
    return "invalid";
  }

  try {
    // Decode the JWT header to get the key_id
    const decodedHeader = jose.decodeProtectedHeader(signedJwt);
    const keyId = decodedHeader.kid;

    if (!keyId) {
      logger.warn("JWT missing key_id (kid)", { component: "plaid.webhook" });
      return "invalid";
    }

    const publicKey = await lookupKey(keyId);
    if (publicKey === "unavailable") return "unverifiable";
    if (publicKey === "unknown") return "invalid";

    // Import the JWK
    const key = await jose.importJWK(publicKey, decodedHeader.alg);

    // Verify the JWT
    const { payload } = await jose.jwtVerify(signedJwt, key, {
      maxTokenAge: "5 min", // Plaid recommends rejecting old webhooks
    });

    // Verify the request body hash matches
    const requestBodyHash = payload.request_body_sha256 as string | undefined;
    if (!requestBodyHash) {
      logger.warn("JWT missing request_body_sha256", { component: "plaid.webhook" });
      return "invalid";
    }

    // Compute SHA256 of request body
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(body);
    const computedHash = hasher.digest("hex");

    if (computedHash !== requestBodyHash) {
      logger.warn("Request body hash mismatch", { component: "plaid.webhook" });
      return "invalid";
    }

    return "valid";
  } catch (error) {
    logger.error("Verification failed", { component: "plaid.webhook" }, error);
    return "invalid";
  }
};
