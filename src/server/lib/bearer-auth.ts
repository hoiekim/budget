import { verifyApiKey as defaultVerifyApiKey } from "./postgres/repositories/api_keys";
import { getMaskedUserById as defaultGetMaskedUserById } from "./postgres/repositories/users";
import type { ResolvedApiKey } from "./postgres/repositories/api_keys";
import type { MaskedUser } from "./postgres/models/user";

export interface BearerAuthInput {
  authorizationHeader: string | string[] | undefined;
  hasCookieSession: boolean;
  requiredScope: string | undefined;
}

export interface BearerAuthResult {
  user: MaskedUser;
}

export type VerifyApiKeyFn = (plaintext: string) => Promise<ResolvedApiKey | null>;
export type GetMaskedUserByIdFn = (user_id: string) => Promise<MaskedUser | undefined>;

export interface BearerAuthDeps {
  verifyApiKey?: VerifyApiKeyFn;
  getMaskedUserById?: GetMaskedUserByIdFn;
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
  deps: BearerAuthDeps = {},
): Promise<BearerAuthResult | null> => {
  if (input.hasCookieSession) return null;
  if (!input.requiredScope) return null;

  const raw = Array.isArray(input.authorizationHeader)
    ? input.authorizationHeader[0]
    : input.authorizationHeader;
  if (typeof raw !== "string" || !raw.startsWith(BEARER_PREFIX)) return null;

  const plaintext = raw.slice(BEARER_PREFIX.length).trim();
  if (!plaintext) return null;

  const verify = deps.verifyApiKey ?? defaultVerifyApiKey;
  const getUser = deps.getMaskedUserById ?? defaultGetMaskedUserById;

  const resolved = await verify(plaintext);
  if (!resolved) return null;
  if (!resolved.scopes.includes(input.requiredScope)) return null;

  const user = await getUser(resolved.user_id);
  if (!user) return null;

  return { user };
};
