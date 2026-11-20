import { isIP } from "net";
import { verifyApiKey } from "./postgres/repositories/api_keys";
import { getMaskedUserById, getUserByAuthSub } from "./postgres/repositories/users";
import type { MaskedUser } from "./postgres/models/user";
import { getSso } from "./sso/state";

export interface BearerAuthInput {
  authorizationHeader: string | string[] | undefined;
  hasCookieSession: boolean;
  requiredScope: string | undefined;
  /** The caller's address, passed on to the identity provider's introspection. */
  ip?: string;
}

export interface BearerAuthResult {
  user: MaskedUser;
}

const BEARER_PREFIX = "Bearer ";

/**
 * A key budget's own store does not hold, checked with the identity
 * provider instead. Accepted when the provider says it is active, its owner
 * is linked to a local user, and its scopes include the route's. Throws
 * `Unavailable` when the provider cannot answer.
 */
const resolveIntrospectedKey = async (
  plaintext: string,
  requiredScope: string,
  ip: string | undefined,
): Promise<BearerAuthResult | null> => {
  const sso = getSso();
  if (!sso) return null;
  const answer = await sso.client.introspect(
    plaintext,
    ip !== undefined && isIP(ip) !== 0 ? { ip } : {},
  );
  if (!answer || !answer.scopes.includes(requiredScope)) return null;
  const user = await getUserByAuthSub(answer.sub);
  return user ? { user } : null;
};

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
 * With single sign-on on, a key `verifyApiKey` does not know is checked with
 * the identity provider instead (`resolveIntrospectedKey`).
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
  if (!resolved) return resolveIntrospectedKey(plaintext, input.requiredScope, input.ip);
  if (!resolved.scopes.includes(input.requiredScope)) return null;

  const user = await getMaskedUserById(resolved.user_id);
  if (!user) return null;

  return { user };
};
