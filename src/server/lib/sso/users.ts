import { SsoError } from "common";
import type { AccessClaims } from "server/lib/auth-client";
import type { MaskedUser } from "server/lib/postgres/models/user";
import {
  createSsoUser,
  getUserByAuthSub,
  linkUserToAuthSub,
} from "server/lib/postgres/repositories/users";

export type SsoUserResult = { user: MaskedUser } | { error: SsoError };

/**
 * The local user a single sign-on stands for: the one already linked to the
 * token's `sub`, else the account `linkUsers` maps the token's username to if
 * it is not linked yet, else a new user named after the token's username.
 * Budget keeps no email addresses, so it never links by email.
 *
 * A username taken by an unlinked local account, the seeded `admin` and
 * `demo` included, is refused rather than guessed at: `AUTH_LINK_USERS` is
 * how an operator says which account is whose.
 */
export const findOrCreateSsoUser = async (
  claims: Pick<AccessClaims, "sub" | "username">,
  linkUsers: Map<string, string>,
): Promise<SsoUserResult> => {
  const linked = await getUserByAuthSub(claims.sub);
  if (linked) return { user: linked };

  const localAccount = linkUsers.get(claims.username);
  if (localAccount !== undefined) {
    const user = await linkUserToAuthSub(localAccount, claims.sub);
    if (user) return { user };
  }

  const created = await createSsoUser(claims.username, claims.sub);
  if (created) return { user: created };

  // A concurrent sign-in by the same person may have linked or created the
  // user between the read above and these writes.
  const raced = await getUserByAuthSub(claims.sub);
  return raced ? { user: raced } : { error: SsoError.AccountExists };
};
