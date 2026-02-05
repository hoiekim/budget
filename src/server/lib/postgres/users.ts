import bcrypt from "bcrypt";
import { DeepPartial } from "common";
import { pool } from "./client";

export interface MaskedUser {
  user_id: string;
  username: string;
}

export type User = MaskedUser & { password: string };

export const maskUser = (user: User): MaskedUser => {
  const { user_id, username } = user;
  return { user_id, username };
};

type IndexUserInput = Omit<User, "user_id"> & {
  user_id?: string;
};

/**
 * Creates or updates a document that represents a user.
 * If id is provided and already exists, existing document will be updated.
 * Otherwise, new document is created with either provided id or auto-generated one.
 * This operation doesn't ensure created user's properties are unique.
 * Therefore an extra validation is recommended when creating a new user.
 * @param user
 * @returns A promise with the result containing _id
 */
export const indexUser = async (user: IndexUserInput) => {
  const { user_id, username, password } = user;
  const hashedPassword = password ? await bcrypt.hash(password, 10) : undefined;
  const updated = new Date().toISOString();

  if (user_id) {
    // Update existing user
    const result = await pool.query(
      `UPDATE users 
       SET username = COALESCE($1, username),
           password = COALESCE($2, password),
           updated = $3
       WHERE user_id = $4
       RETURNING user_id`,
      [username, hashedPassword, updated, user_id]
    );

    if (result.rowCount === 0) {
      // Insert if not exists
      const insertResult = await pool.query(
        `INSERT INTO users (user_id, username, password, updated)
         VALUES ($1, $2, $3, $4)
         RETURNING user_id`,
        [user_id, username, hashedPassword, updated]
      );
      return { _id: insertResult.rows[0].user_id };
    }
    return { _id: result.rows[0].user_id };
  } else {
    // Insert new user with auto-generated id
    const result = await pool.query(
      `INSERT INTO users (username, password, updated)
       VALUES ($1, $2, $3)
       RETURNING user_id`,
      [username, hashedPassword, updated]
    );
    return { _id: result.rows[0].user_id };
  }
};

/**
 * Searches for a user. Prints out warning log if multiple users are found.
 * @param user
 * @returns A promise to be a User object
 */
export const searchUser = async (user: Partial<MaskedUser>): Promise<User | undefined> => {
  if (user.user_id) {
    const result = await pool.query<User>(
      `SELECT user_id, username, password FROM users WHERE user_id = $1`,
      [user.user_id]
    );
    return result.rows[0];
  }

  const conditions: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (user.username) {
    conditions.push(`username = $${paramIndex++}`);
    values.push(user.username);
  }

  if (conditions.length === 0) return undefined;

  const result = await pool.query<User>(
    `SELECT user_id, username, password FROM users WHERE ${conditions.join(" AND ")}`,
    values
  );

  if (result.rows.length > 1) {
    console.warn("Multiple users are found by user:", user);
  }

  return result.rows[0];
};

export type PartialUser = { user_id: string } & DeepPartial<User>;

/**
 * Updates user document with given object.
 * @param user
 * @returns A promise with the update result
 */
export const updateUser = async (user: PartialUser) => {
  if (!user) return;
  const { user_id, username, password } = user;

  const updates: string[] = [];
  const values: any[] = [];
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

  if (updates.length === 1) return; // Only updated timestamp, no actual changes

  const result = await pool.query(
    `UPDATE users SET ${updates.join(", ")} WHERE user_id = $${paramIndex}`,
    values
  );

  return result;
};

/**
 * Gets a user by ID.
 * @param user_id
 * @returns A promise with the user or undefined
 */
export const getUserById = async (user_id: string): Promise<User | undefined> => {
  const result = await pool.query<User>(
    `SELECT user_id, username, password FROM users WHERE user_id = $1`,
    [user_id]
  );
  return result.rows[0];
};

/**
 * Soft-deletes a user by ID.
 * @param user_id
 * @returns A promise with true if deleted, false otherwise
 */
export const deleteUser = async (user_id: string): Promise<boolean> => {
  const result = await pool.query(
    `UPDATE users SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE user_id = $1 RETURNING user_id`,
    [user_id]
  );
  return (result.rowCount || 0) > 0;
};
