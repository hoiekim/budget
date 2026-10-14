import * as jose from "jose";
import { getProductionClient } from "./util";
import { logger } from "../logger";
import { plaidKeyFetchRateLimiter } from "../rate-limit";

const KEY_CACHE_TTL = 1000 * 60 * 60; // 1 hour
// Short, so a transient Plaid error delays a genuine new key by at most one webhook, which Plaid retries.
export const MISSING_KEY_CACHE_TTL = 1000 * 60 * 5;
const ttlOf = (entry: { key: jose.JWK | null }) => (entry.key ? KEY_CACHE_TTL : MISSING_KEY_CACHE_TTL);

const KEY_FETCH_BUCKET = "global";

/**
 * Verify a Plaid webhook request.
 * 
 * Plaid signs webhooks with a JWT in the Plaid-Verification header.
 * This function validates the JWT signature using Plaid's public keys.
 * 
 * @param body - The raw request body as a string
 * @param signedJwt - The Plaid-Verification header value
 * @returns true if verification succeeds, false otherwise
 */
export const verifyWebhook = async (
  body: string,
  signedJwt: string | undefined
): Promise<boolean> => {
  if (!signedJwt) {
    logger.warn("Missing Plaid-Verification header", { component: "plaid.webhook" });
    return false;
  }

  try {
    // Decode the JWT header to get the key_id
    const decodedHeader = jose.decodeProtectedHeader(signedJwt);
    const keyId = decodedHeader.kid;

    if (!keyId) {
      logger.warn("JWT missing key_id (kid)", { component: "plaid.webhook" });
      return false;
    }

    // Get the public key (from cache or fetch)
    const publicKey = await getVerificationKey(keyId);
    if (!publicKey) {
      logger.warn("Failed to get verification key", { component: "plaid.webhook" });
      return false;
    }

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
      return false;
    }

    // Compute SHA256 of request body
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(body);
    const computedHash = hasher.digest("hex");

    if (computedHash !== requestBodyHash) {
      logger.warn("Request body hash mismatch", { component: "plaid.webhook" });
      return false;
    }

    return true;
  } catch (error) {
    logger.error("Verification failed", { component: "plaid.webhook" }, error);
    return false;
  }
};

/**
 * Builds a verification-key lookup around `fetchKey`. Every answer is cached,
 * a key for an hour and a key_id that couldn't be fetched for five minutes, so
 * a key_id costs one fetch per TTL rather than one per request. Concurrent
 * requests for the same key_id share one fetch, and uncached fetches are capped
 * process-wide by `plaidKeyFetchRateLimiter`.
 */
export const createVerificationKeyLookup = (fetchKey: (keyId: string) => Promise<jose.JWK>) => {
  /** Verification keys by key_id; `null` remembers a key_id that couldn't be fetched. */
  const keyCache = new Map<string, { key: jose.JWK | null; fetchedAt: number }>();
  const inflightKeys = new Map<string, Promise<jose.JWK | null>>();

  // Periodically evict stale key cache entries to prevent unbounded growth.
  setInterval(() => {
    const now = Date.now();
    for (const [keyId, entry] of keyCache) {
      if (now - entry.fetchedAt >= ttlOf(entry)) keyCache.delete(keyId);
    }
  }, MISSING_KEY_CACHE_TTL).unref();

  const fetchAndCache = async (keyId: string): Promise<jose.JWK | null> => {
    try {
      const key = await fetchKey(keyId);
      keyCache.set(keyId, { key, fetchedAt: Date.now() });
      return key;
    } catch (error) {
      logger.error("Failed to fetch verification key", { component: "plaid.webhook" }, error);
      keyCache.set(keyId, { key: null, fetchedAt: Date.now() });
      return null;
    }
  };

  return async (keyId: string): Promise<jose.JWK | null> => {
    const cached = keyCache.get(keyId);
    if (cached && Date.now() - cached.fetchedAt < ttlOf(cached)) return cached.key;

    const inflight = inflightKeys.get(keyId);
    if (inflight) return inflight;

    if (plaidKeyFetchRateLimiter.isLimited(KEY_FETCH_BUCKET)) {
      logger.warn("Verification key fetches over the cap; not fetching", { component: "plaid.webhook" });
      return null;
    }
    plaidKeyFetchRateLimiter.consume(KEY_FETCH_BUCKET);

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
