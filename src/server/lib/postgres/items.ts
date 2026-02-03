import { JSONItem, ItemStatus } from "common";
import { pool } from "./client";
import { MaskedUser, searchUser, User } from "./users";

export type PartialItem = { item_id: string } & Partial<JSONItem>;

/**
 * Updates or inserts items documents associated with given user.
 * @param user
 * @param items
 * @param upsert
 * @returns A promise to be an array of result objects
 */
export const upsertItems = async (
  user: MaskedUser,
  items: PartialItem[],
  upsert: boolean = true
) => {
  if (!items.length) return [];
  const { user_id } = user;
  const results: { update: { _id: string }; status: number }[] = [];
  const updated = new Date().toISOString();

  for (const item of items) {
    const { item_id, plaidError, ...rest } = item;

    if (upsert) {
      const result = await pool.query(
        `INSERT INTO items (item_id, user_id, data, updated)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (item_id) DO UPDATE SET
           data = items.data || $3,
           updated = $4
         WHERE items.user_id = $2
         RETURNING item_id`,
        [item_id, user_id, JSON.stringify(rest), updated]
      );
      results.push({ update: { _id: item_id }, status: result.rowCount ? 200 : 404 });
    } else {
      const result = await pool.query(
        `UPDATE items SET data = data || $3, updated = $4
         WHERE item_id = $1 AND user_id = $2
         RETURNING item_id`,
        [item_id, user_id, JSON.stringify(rest), updated]
      );
      results.push({ update: { _id: item_id }, status: result.rowCount ? 200 : 404 });
    }
  }

  return results;
};

/**
 * Searches for items associated with given user.
 * @param user
 * @returns A promise to be an array of Item objects
 */
export const searchItems = async (user?: MaskedUser) => {
  const { user_id } = user || {};

  let query: string;
  let values: any[];

  if (user_id) {
    query = `SELECT item_id, data FROM items WHERE user_id = $1`;
    values = [user_id];
  } else {
    query = `SELECT item_id, data FROM items`;
    values = [];
  }

  const result = await pool.query<{
    item_id: string;
    data: any;
  }>(query, values);

  return result.rows.map((row) => ({
    ...row.data,
    item_id: row.item_id,
  })) as JSONItem[];
};

/**
 * Gets item associated with given item_id.
 * @param item_id
 * @returns A promise to be an Item object
 */
export const getItem = async (item_id: string) => {
  const result = await pool.query<{
    item_id: string;
    data: any;
  }>(
    `SELECT item_id, data FROM items WHERE item_id = $1`,
    [item_id]
  );

  if (result.rows.length === 0) return undefined;

  const row = result.rows[0];
  return {
    ...row.data,
    item_id: row.item_id,
  } as JSONItem;
};

export const updateItemStatus = async (item_id: string, status: ItemStatus) => {
  const result = await pool.query<{
    user_id: string;
    data: any;
  }>(
    `SELECT user_id, data FROM items WHERE item_id = $1`,
    [item_id]
  );

  if (result.rows.length === 0) return;

  const { user_id } = result.rows[0];
  const foundUser = await searchUser({ user_id });
  if (!foundUser) return;

  return await upsertItems(foundUser, [{ item_id, status }]);
};

export const getUserItem = async (
  item_id: string
): Promise<{ user: User; item: JSONItem } | undefined> => {
  const result = await pool.query<{
    item_id: string;
    user_id: string;
    data: any;
  }>(
    `SELECT item_id, user_id, data FROM items WHERE item_id = $1`,
    [item_id]
  );

  if (result.rows.length === 0) return;

  const row = result.rows[0];
  const foundUser = await searchUser({ user_id: row.user_id });
  if (!foundUser) return;

  const item = {
    ...row.data,
    item_id: row.item_id,
  } as JSONItem;

  return { user: foundUser, item };
};

/**
 * Delete an item with given item_id.
 * Also deletes associated accounts, holdings, transactions, etc.
 * @param user
 * @param item_id
 * @returns A promise with the delete results
 */
export const deleteItem = async (user: MaskedUser, item_id: string) => {
  const { user_id } = user;

  // Delete the item
  const itemResult = pool.query(
    `DELETE FROM items WHERE user_id = $1 AND item_id = $2`,
    [user_id, item_id]
  );

  // Get all account IDs for this item
  const accountsQuery = await pool.query<{ account_id: string }>(
    `SELECT account_id FROM accounts WHERE user_id = $1 AND data->>'item_id' = $2`,
    [user_id, item_id]
  );
  const accountIds = accountsQuery.rows.map((r) => r.account_id);

  // Delete related data
  const otherResults = accountIds.length > 0 ? Promise.all([
    pool.query(`DELETE FROM accounts WHERE user_id = $1 AND account_id = ANY($2)`, [user_id, accountIds]),
    pool.query(`DELETE FROM holdings WHERE user_id = $1 AND data->>'account_id' = ANY($2)`, [user_id, accountIds]),
    pool.query(`DELETE FROM transactions WHERE user_id = $1 AND data->>'account_id' = ANY($2)`, [user_id, accountIds]),
    pool.query(`DELETE FROM split_transactions WHERE user_id = $1 AND account_id = ANY($2)`, [user_id, accountIds]),
    pool.query(`DELETE FROM investment_transactions WHERE user_id = $1 AND data->>'account_id' = ANY($2)`, [user_id, accountIds]),
  ]) : Promise.resolve([]);

  return Promise.all([itemResult, otherResults]);
};
