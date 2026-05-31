import { verifyApiKey } from "./postgres/repositories/api_keys";
import { getMaskedUserById } from "./postgres/repositories/users";
import type { MaskedUser } from "./postgres/models/user";

export interface BearerAuthInput {
  authorizationHeader: string | string[] | undefined;
  hasCookieSession: boolean;
  requiredScope: string | undefined;
}

export interface BearerAuthResult {
  user: MaskedUser;
}

const BEARER_PREFIX = "Bearer ";

/**
 * Resolve Authorization: Bearer credentials against the API-key store.
 *
 * Returns the resolved MaskedUser when (and only when):
 * - No cookie session is present (cookie auth always wins)
 * - The matched route declares a `requiredScope`
 * - The Authorization header is a well-formed Bearer token
 * - `verifyApiKey` returns a non-null, non-revoked, non-expired record
 * - The resolved scopes include the route's `requiredScope`
 * - The user_id maps to an existing MaskedUser
 *
 * Returns `null` for every other case. Callers should treat `null` as
 * "no bearer credentials applied" and continue to the normal auth check.
 */
export const resolveBearerAuth = async (
  input: BearerAuthInput,
): Promise<BearerAuthResult | null> => {
  if (input.hasCookieSession) return null;
  if (!input.requiredScope) return null;

  const raw = Array.isArray(input.authorizationHeader)
    ? input.authorizationHeader[0]
    : input.authorizationHeader;
  if (typeof raw !== "string" || !raw.startsWith(BEARER_PREFIX)) return null;

  const plaintext = raw.slice(BEARER_PREFIX.length).trim();
  if (!plaintext) return null;

  const resolved = await verifyApiKey(plaintext);
  if (!resolved) return null;
  if (!resolved.scopes.includes(input.requiredScope)) return null;

  const user = await getMaskedUserById(resolved.user_id);
  if (!user) return null;

  return { user };
};
