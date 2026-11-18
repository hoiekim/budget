import { SsoError } from "common";
import type { AccessClaims, IdClaims } from "server/lib/auth-client";
import type { MaskedUser } from "server/lib/postgres/models/user";
import {
  createSsoUser,
  getUserByAuthSub,
  linkUserByEmail,
  linkUserToAuthSub,
} from "server/lib/postgres/repositories/users";

export type SsoUserResult = { user: MaskedUser } | { error: SsoError };

/**
 * The local user a single sign-on stands for: the one already linked to the
 * token's `sub`, else the account `linkUsers` maps the token's username to if
 * it is not linked yet, else the unlinked account with the ID token's email
 * in any letter case, else a new user named after the token's username,
 * keeping that email when no other account has it.
 *
 * The email is matched whether or not the provider says it is verified: the
 * operator filled in the accounts' addresses, and the auth identity service
 * sets an address a person chose only once they confirm it (an unconfirmed
 * one was entered by its administrator), so a match is as trustworthy as
 * `AUTH_LINK_USERS`. A provider that lets people claim addresses they have
 * not confirmed must not be used this way.
 *
 * A username taken by an unlinked local account, the seeded `admin` and
 * `demo` included, is refused rather than guessed at: `AUTH_LINK_USERS` or
 * the account's email is how an operator says which account is whose.
 */
export const findOrCreateSsoUser = async (
  claims: Pick<AccessClaims, "sub" | "username"> & Pick<IdClaims, "email">,
  linkUsers: Map<string, string>,
): Promise<SsoUserResult> => {
  const linked = await getUserByAuthSub(claims.sub);
  if (linked) return { user: linked };

  const localAccount = linkUsers.get(claims.username);
  if (localAccount !== undefined) {
    const user = await linkUserToAuthSub(localAccount, claims.sub);
    if (user) return { user };
  }

  const email = typeof claims.email === "string" ? claims.email.trim() : "";
  if (email) {
    const user = await linkUserByEmail(email, claims.sub);
    if (user) return { user };
  }

  // An address another account holds, a deleted one included, would break
  // the unique index on emails: the user is created without it instead.
  const created =
    (email && (await createSsoUser(claims.username, claims.sub, email))) ||
    (await createSsoUser(claims.username, claims.sub));
  if (created) return { user: created };

  // A concurrent sign-in by the same person may have linked or created the
  // user between the read above and these writes.
  const raced = await getUserByAuthSub(claims.sub);
  return raced ? { user: raced } : { error: SsoError.AccountExists };
};
