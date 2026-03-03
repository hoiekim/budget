import * as jose from "jose";
import { getProductionClient } from "./util";

// Cache for verification keys (keyed by key_id)
const keyCache = new Map<string, { key: jose.JWK; fetchedAt: number }>();
const KEY_CACHE_TTL = 1000 * 60 * 60; // 1 hour

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
    console.warn("[Plaid Webhook] Missing Plaid-Verification header");
    return false;
  }

  try {
    // Decode the JWT header to get the key_id
    const decodedHeader = jose.decodeProtectedHeader(signedJwt);
    const keyId = decodedHeader.kid;

    if (!keyId) {
      console.warn("[Plaid Webhook] JWT missing key_id (kid)");
      return false;
    }

    // Get the public key (from cache or fetch)
    const publicKey = await getVerificationKey(keyId);
    if (!publicKey) {
      console.warn("[Plaid Webhook] Failed to get verification key");
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
      console.warn("[Plaid Webhook] JWT missing request_body_sha256");
      return false;
    }

    // Compute SHA256 of request body
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(body);
    const computedHash = hasher.digest("hex");

    if (computedHash !== requestBodyHash) {
      console.warn("[Plaid Webhook] Request body hash mismatch");
      return false;
    }

    return true;
  } catch (error) {
    console.error("[Plaid Webhook] Verification failed:", error);
    return false;
  }
};

/**
 * Get a Plaid webhook verification key.
 * Uses caching to avoid repeated API calls.
 */
const getVerificationKey = async (keyId: string): Promise<jose.JWK | null> => {
  // Check cache first
  const cached = keyCache.get(keyId);
  if (cached && Date.now() - cached.fetchedAt < KEY_CACHE_TTL) {
    return cached.key;
  }

  try {
    // Webhooks only come from production - always use production client
    const client = getProductionClient();
    const response = await client.webhookVerificationKeyGet({ key_id: keyId });
    const key = response.data.key as jose.JWK;

    // Cache the key
    keyCache.set(keyId, { key, fetchedAt: Date.now() });

    return key;
  } catch (error) {
    console.error("[Plaid Webhook] Failed to fetch verification key:", error);
    return null;
  }
};
