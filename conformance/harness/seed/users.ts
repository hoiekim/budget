/** Users beyond the `admin` and `demo` every server start creates. */
import type { Stack } from "../stack";
import type { ApiClient } from "../client";

export interface SeededUser {
  user_id: string;
  username: string;
  password: string;
}

/**
 * Creates a user who can sign in with a password, the way the server stores
 * one: a bcrypt hash. The cost is the lowest bcrypt allows, to keep tests
 * fast; both servers verify any cost.
 */
export const createUser = async (
  stack: Stack,
  username: string,
  { password = `${username}-password`, email, auth_sub }: { password?: string | null; email?: string; auth_sub?: string } = {},
): Promise<SeededUser> => {
  const hash = password === null ? null : await Bun.password.hash(password, { algorithm: "bcrypt", cost: 4 });
  const row = await stack.db.insert<{ user_id: string }>("users", { username, password: hash, email, auth_sub });
  return { user_id: row.user_id, username, password: password ?? "" };
};

/** Creates a user and signs in as them. */
export const createUserClient = async (
  stack: Stack,
  username: string,
): Promise<{ user: SeededUser; client: ApiClient }> => {
  const user = await createUser(stack, username);
  return { user, client: await stack.login(username, user.password) };
};
