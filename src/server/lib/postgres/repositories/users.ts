import bcrypt from "bcrypt";
import { DeepPartial } from "common";
import { MaskedUser, User, UserModel, usersTable, USER_ID } from "../models";

export type IndexUserInput = Omit<User, "user_id"> & { user_id?: string };
export type PartialUser = { user_id: string } & DeepPartial<User>;

export const maskUser = (user: User): MaskedUser => {
  const { user_id, username } = user;
  return { user_id, username };
};

export const indexUser = async (user: IndexUserInput): Promise<{ _id: string } | undefined> => {
  const { user_id, username, password } = user;
  const hashedPassword = password ? await bcrypt.hash(password, 10) : undefined;

  try {
    const row: Record<string, unknown> = { username, password: hashedPassword };
    if (user_id) row.user_id = user_id;
    
    const model = await usersTable.upsert(row);
    if (model) return { _id: model.user_id };
    return undefined;
  } catch (error) {
    console.error("Failed to index user:", error);
    return undefined;
  }
};

export const searchUser = async (user: Partial<MaskedUser>): Promise<User | undefined> => {
  try {
    const filters: Record<string, unknown> = {};
    if (user.user_id) filters[USER_ID] = user.user_id;
    if (user.username) filters.username = user.username;
    
    if (Object.keys(filters).length === 0) return undefined;
    
    const model = await usersTable.queryOne(filters);
    return model?.toUser();
  } catch (error) {
    console.error("Failed to search user:", error);
    return undefined;
  }
};

export const updateUser = async (user: PartialUser): Promise<boolean> => {
  if (!user) return false;
  const { user_id, username, password } = user;

  const updates: Record<string, unknown> = {};
  if (username !== undefined) updates.username = username;
  if (password !== undefined) updates.password = await bcrypt.hash(password, 10);

  if (Object.keys(updates).length === 0) return false;

  try {
    const model = await usersTable.update(user_id, updates);
    return model !== null;
  } catch (error) {
    console.error("Failed to update user:", error);
    return false;
  }
};

export const getUserById = async (user_id: string): Promise<User | undefined> => {
  try {
    const model = await usersTable.queryOne({ [USER_ID]: user_id });
    return model?.toUser();
  } catch (error) {
    console.error("Failed to get user by ID:", error);
    return undefined;
  }
};

export const deleteUser = async (user_id: string): Promise<boolean> => {
  try {
    return await usersTable.softDelete(user_id);
  } catch (error) {
    console.error("Failed to delete user:", error);
    return false;
  }
};
