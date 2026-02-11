/**
 * User repository - CRUD operations for users.
 */

import bcrypt from "bcrypt";
import { DeepPartial } from "common";
import { pool } from "../client";
import {
  MaskedUser,
  User,
  UserModel,
  USERS,
  USER_ID,
} from "../models";
import {
  prepareQuery,
  buildUpdate,
  UpsertResult,
  successResult,
  errorResult,
} from "../database";

// Types

export type IndexUserInput = Omit<User, "user_id"> & {
  user_id?: string;
};

export type PartialUser = { user_id: string } & DeepPartial<User>;

// Helpers

/**
 * Creates a MaskedUser from a User.
 */
export const maskUser = (user: User): MaskedUser => {
  const { user_id, username } = user;
  return { user_id, username };
};

// Repository Functions

/**
 * Creates or updates a user.
 * If user_id is provided and exists, updates the user.
 * Otherwise, creates a new user with either provided or auto-generated ID.
 */
export const indexUser = async (
  user: IndexUserInput
): Promise<{ _id: string } | undefined> => {
  const { user_id, username, password } = user;
  const hashedPassword = password ? await bcrypt.hash(password, 10) : undefined;

  try {
    if (user_id) {
      // Try to update existing user
      const updateResult = await pool.query<{ user_id: string }>(
        `UPDATE ${USERS}
         SET username = COALESCE($1, username),
             password = COALESCE($2, password),
             updated = CURRENT_TIMESTAMP
         WHERE ${USER_ID} = $3
         RETURNING ${USER_ID}`,
        [username, hashedPassword, user_id]
      );

      if (updateResult.rowCount === 0) {
        // Insert if not exists
        const insertResult = await pool.query<{ user_id: string }>(
          `INSERT INTO ${USERS} (${USER_ID}, username, password, updated)
           VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
           RETURNING ${USER_ID}`,
          [user_id, username, hashedPassword]
        );
        return { _id: insertResult.rows[0].user_id };
      }
      return { _id: updateResult.rows[0].user_id };
    } else {
      // Insert new user with auto-generated ID
      const result = await pool.query<{ user_id: string }>(
        `INSERT INTO ${USERS} (username, password, updated)
         VALUES ($1, $2, CURRENT_TIMESTAMP)
         RETURNING ${USER_ID}`,
        [username, hashedPassword]
      );
      return { _id: result.rows[0].user_id };
    }
  } catch (error) {
    console.error("Failed to index user:", error);
    return undefined;
  }
};

/**
 * Searches for a user by ID or username.
 * Returns undefined if not found.
 */
export const searchUser = async (
  user: Partial<MaskedUser>
): Promise<User | undefined> => {
  try {
    if (user.user_id) {
      const result = await pool.query<Record<string, unknown>>(
        `SELECT ${USER_ID}, username, password FROM ${USERS} WHERE ${USER_ID} = $1`,
        [user.user_id]
      );
      if (result.rows[0]) {
        const model = new UserModel(result.rows[0] as Record<string, unknown>);
        return model.toUser();
      }
      return undefined;
    }

    const conditions: string[] = [];
    const values: string[] = [];
    let paramIndex = 1;

    if (user.username) {
      conditions.push(`username = $${paramIndex++}`);
      values.push(user.username);
    }

    if (conditions.length === 0) return undefined;

    const result = await pool.query<Record<string, unknown>>(
      `SELECT ${USER_ID}, username, password FROM ${USERS} WHERE ${conditions.join(" AND ")}`,
      values
    );

    if (result.rows.length > 1) {
      console.warn("Multiple users found by criteria:", user);
    }

    if (result.rows[0]) {
      const model = new UserModel(result.rows[0] as Record<string, unknown>);
      return model.toUser();
    }
    return undefined;
  } catch (error) {
    console.error("Failed to search user:", error);
    return undefined;
  }
};

/**
 * Updates a user with partial data.
 */
export const updateUser = async (user: PartialUser): Promise<boolean> => {
  if (!user) return false;
  const { user_id, username, password } = user;

  const updates: string[] = [];
  const values: (string | undefined)[] = [];
  let paramIndex = 1;

  if (username !== undefined) {
    updates.push(`username = $${paramIndex++}`);
    values.push(username);
  }

  if (password !== undefined) {
    updates.push(`password = $${paramIndex++}`);
    values.push(await bcrypt.hash(password, 10));
  }

  updates.push(`updated = $${paramIndex++}`);
  values.push(new Date().toISOString());

  values.push(user_id);

  if (updates.length === 1) return false; // Only updated timestamp

  try {
    const result = await pool.query(
      `UPDATE ${USERS} SET ${updates.join(", ")} WHERE ${USER_ID} = $${paramIndex}`,
      values
    );
    return (result.rowCount || 0) > 0;
  } catch (error) {
    console.error("Failed to update user:", error);
    return false;
  }
};

/**
 * Gets a user by ID.
 */
export const getUserById = async (user_id: string): Promise<User | undefined> => {
  try {
    const result = await pool.query<Record<string, unknown>>(
      `SELECT ${USER_ID}, username, password FROM ${USERS} WHERE ${USER_ID} = $1`,
      [user_id]
    );
    if (result.rows[0]) {
      const model = new UserModel(result.rows[0] as Record<string, unknown>);
      return model.toUser();
    }
    return undefined;
  } catch (error) {
    console.error("Failed to get user by ID:", error);
    return undefined;
  }
};

/**
 * Soft-deletes a user by ID.
 */
export const deleteUser = async (user_id: string): Promise<boolean> => {
  try {
    const result = await pool.query(
      `UPDATE ${USERS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
       WHERE ${USER_ID} = $1
       RETURNING ${USER_ID}`,
      [user_id]
    );
    return (result.rowCount || 0) > 0;
  } catch (error) {
    console.error("Failed to delete user:", error);
    return false;
  }
};
