import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { pool } from "../client";
import { ApiKeyJSON, ApiKeyModel, apiKeysTable } from "../models";

const KEY_PLAINTEXT_PREFIX = "bk_";

/**
 * Generate a new API key. Returns both the plaintext (shown once to the user)
 * and the storable row data (hash + prefix).
 *
 * Plaintext format: `bk_<43 base64url chars>` from 32 random bytes (256 bits).
 * Stored hash: SHA-256 of the full plaintext (hex). High-entropy keys don't
 * need a slow hash — SHA-256 indexed lookup gives O(1) verification.
 */
export const generateApiKey = (): { plaintext: string; hash: string; prefix: string } => {
  const random = randomBytes(32).toString("base64url");
  const plaintext = `${KEY_PLAINTEXT_PREFIX}${random}`;
  const hash = createHash("sha256").update(plaintext).digest("hex");
  const prefix = plaintext.slice(0, 11);
  return { plaintext, hash, prefix };
};

export const hashApiKey = (plaintext: string): string => {
  return createHash("sha256").update(plaintext).digest("hex");
};

export interface CreateApiKeyInput {
  user_id: string;
  name: string;
  scopes: string[];
  expires_at?: string | null;
}

export interface CreatedApiKey {
  key_id: string;
  plaintext: string;
  prefix: string;
}

export const createApiKey = async (
  input: CreateApiKeyInput,
): Promise<CreatedApiKey> => {
  const { plaintext, hash, prefix } = generateApiKey();
  const result = await apiKeysTable.insert(
    {
      user_id: input.user_id,
      name: input.name,
      key_hash: hash,
      key_prefix: prefix,
      scopes: input.scopes,
      expires_at: input.expires_at ?? null,
    },
    ["key_id"],
  );
  if (!result) throw new Error("Failed to create API key");
  return { key_id: result.key_id as string, plaintext, prefix };
};

export const listApiKeys = async (user_id: string): Promise<ApiKeyJSON[]> => {
  const sql = `
    SELECT key_id, user_id, name, key_prefix, scopes,
           created_at, last_used_at, revoked_at, expires_at
    FROM api_keys
    WHERE user_id = $1 AND revoked_at IS NULL
    ORDER BY created_at DESC
  `;
  const result = await pool.query(sql, [user_id]);
  return result.rows.map((row: unknown) => {
    // Cast: we deliberately omit key_hash from the SELECT, so the row
    // doesn't satisfy ApiKeyModel's full typeChecker. Validate the visible
    // fields only.
    return new ApiKeyModel({ ...(row as object), key_hash: "" }).toJSON();
  });
};

export const revokeApiKey = async (
  key_id: string,
  user_id: string,
): Promise<boolean> => {
  const sql = `
    UPDATE api_keys SET revoked_at = CURRENT_TIMESTAMP
    WHERE key_id = $1 AND user_id = $2 AND revoked_at IS NULL
    RETURNING key_id
  `;
  const result = await pool.query(sql, [key_id, user_id]);
  return (result.rowCount ?? 0) > 0;
};

export interface ResolvedApiKey {
  key_id: string;
  user_id: string;
  scopes: string[];
}

/**
 * Look up an API key by its plaintext value. Returns the resolved key with
 * scopes, or `null` if invalid / revoked / expired. Uses an indexed lookup on
 * the SHA-256 hash, then a constant-time equality check as defense-in-depth
 * against length-extension or hash-bucket leakage.
 */
export const verifyApiKey = async (
  plaintext: string,
): Promise<ResolvedApiKey | null> => {
  if (!plaintext.startsWith(KEY_PLAINTEXT_PREFIX)) return null;
  const hash = hashApiKey(plaintext);
  const sql = `
    SELECT key_id, user_id, key_hash, scopes, revoked_at, expires_at
    FROM api_keys
    WHERE key_hash = $1
  `;
  const result = await pool.query(sql, [hash]);
  if (result.rowCount === 0) return null;
  const row = result.rows[0] as {
    key_id: string;
    user_id: string;
    key_hash: string;
    scopes: string[];
    revoked_at: string | null;
    expires_at: string | null;
  };

  const expected = Buffer.from(row.key_hash, "hex");
  const actual = Buffer.from(hash, "hex");
  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;

  if (row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return null;
  }

  // Best-effort touch; failures here must not block the request.
  pool
    .query(`UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE key_id = $1`, [
      row.key_id,
    ])
    .catch(() => undefined);

  return { key_id: row.key_id, user_id: row.user_id, scopes: row.scopes };
};
