import { hashPassword } from "../../password";
import {
  MaskedUser,
  User,
  UserModel,
  usersTable,
  USER_ID,
  USERNAME,
  EMAIL,
  AUTH_SUB,
} from "../models";

export type IndexUserInput = Omit<User, "user_id"> & { user_id?: string };

export const maskUser = (user: User): MaskedUser => {
  const { user_id, username } = user;
  return { user_id, username };
};

export const writeUser = async (user: IndexUserInput): Promise<{ _id: string } | undefined> => {
  const { user_id, username, password } = user;
  const hashedPassword = password ? await hashPassword(password) : undefined;

  const row: Record<string, unknown> = { username, password: hashedPassword };
  if (user_id) row.user_id = user_id;

  const result = await usersTable.upsert(row);
  if (result) return { _id: result.user_id as string };
  return undefined;
};

export const searchUser = async (user: Partial<MaskedUser>): Promise<User | undefined> => {
  const filters: Record<string, unknown> = {};
  if (user.user_id) filters[USER_ID] = user.user_id;
  if (user.username) filters.username = user.username;

  if (Object.keys(filters).length === 0) return undefined;

  const model = await usersTable.queryOne(filters);
  return model?.toUser();
};

/**
 * The user `username` names, if they can sign in with a password: users
 * created by single sign-on have none, and with `excludeLinked` an account
 * linked to the identity provider signs in only through it.
 */
export const searchPasswordUser = async (
  username: string,
  { excludeLinked = false }: { excludeLinked?: boolean } = {},
): Promise<User | undefined> => {
  const model = await usersTable.queryOne({ [USERNAME]: username });
  if (!model?.password || (excludeLinked && model.auth_sub !== null)) return undefined;
  return model.toUser();
};

export const getUserByAuthSub = async (auth_sub: string): Promise<MaskedUser | undefined> => {
  const model = await usersTable.queryOne({ [AUTH_SUB]: auth_sub });
  return model?.toMaskedUser();
};

const linkToAuthSub = async (
  model: UserModel | null | undefined,
  auth_sub: string,
): Promise<MaskedUser | undefined> => {
  if (!model || model.auth_sub !== null) return undefined;
  const linked = await usersTable.update(
    model.user_id,
    { [AUTH_SUB]: auth_sub },
    [USER_ID],
    undefined,
    undefined,
    [{ column: AUTH_SUB, value: null }],
  );
  return linked ? model.toMaskedUser() : undefined;
};

/**
 * Links the account `username` names to the identity provider's `auth_sub`,
 * unless it is already linked. `undefined` when there is no such account or
 * it is linked already, including by a concurrent sign-in.
 */
export const linkUserToAuthSub = async (
  username: string,
  auth_sub: string,
): Promise<MaskedUser | undefined> =>
  linkToAuthSub(await usersTable.queryOne({ [USERNAME]: username }), auth_sub);

/**
 * Links the account whose email is `email`, in any letter case, to the
 * identity provider's `auth_sub`, unless it is already linked. `undefined`
 * when there is no such account or it is linked already, including by a
 * concurrent sign-in.
 */
export const linkUserByEmail = async (
  email: string,
  auth_sub: string,
): Promise<MaskedUser | undefined> => {
  const [model] = await usersTable.query(
    {},
    { equalsIgnoringCase: { column: EMAIL, value: email }, limit: 1 },
  );
  return linkToAuthSub(model, auth_sub);
};

/**
 * Creates a user with no password for a single sign-on account, with
 * `email` if given. `undefined` when the username, `auth_sub` or email is
 * taken.
 */
export const createSsoUser = async (
  username: string,
  auth_sub: string,
  email?: string,
): Promise<MaskedUser | undefined> => {
  const row = await usersTable.insert(
    { [USERNAME]: username, [AUTH_SUB]: auth_sub, [EMAIL]: email },
    [USER_ID, USERNAME],
    { onConflictDoNothing: true },
  );
  return row ? { user_id: row[USER_ID] as string, username: row[USERNAME] as string } : undefined;
};

export const getUserById = async (user_id: string): Promise<User | undefined> => {
  const model = await usersTable.queryOne({ [USER_ID]: user_id });
  return model?.toUser();
};

export const getMaskedUserById = async (
  user_id: string,
): Promise<MaskedUser | undefined> => {
  const model = await usersTable.queryOne({ [USER_ID]: user_id });
  return model?.toMaskedUser();
};

export const deleteUser = async (user_id: string): Promise<boolean> => {
  return await usersTable.softDelete(user_id);
};
