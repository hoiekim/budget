/**
 * Item repository - CRUD operations for items.
 */

import { JSONItem, ItemProvider } from "common";
import { pool } from "../client";
import {
  MaskedUser,
  ItemModel,
  ItemRow,
  ITEMS,
  ITEM_ID,
  USER_ID,
  INSTITUTION_ID,
  ACCOUNTS,
  TRANSACTIONS,
  INVESTMENT_TRANSACTIONS,
  SPLIT_TRANSACTIONS,
  SNAPSHOTS,
  HOLDINGS,
} from "../models";
import {
  buildUpsert,
  buildUpdate,
  buildBulkSoftDelete,
  buildSelectWithFilters,
  selectWithFilters,
  UpsertResult,
  successResult,
  errorResult,
  noChangeResult,
} from "../database";

// =============================================
// Types
// =============================================

export type PartialItem = { item_id: string } & Partial<JSONItem>;

// =============================================
// Query Helpers
// =============================================

const rowToItem = (row: ItemRow): JSONItem => new ItemModel(row).toJSON();

// =============================================
// Repository Functions
// =============================================

/**
 * Gets all items for a user.
 */
export const getItems = async (user: MaskedUser): Promise<JSONItem[]> => {
  const rows = await selectWithFilters<ItemRow>(pool, ITEMS, "*", {
    user_id: user.user_id,
  });
  return rows.map(rowToItem);
};

/**
 * Gets a single item by ID.
 */
export const getItem = async (
  user: MaskedUser,
  item_id: string
): Promise<JSONItem | null> => {
  const rows = await selectWithFilters<ItemRow>(pool, ITEMS, "*", {
    user_id: user.user_id,
    primaryKey: { column: ITEM_ID, value: item_id },
  });
  return rows.length > 0 ? rowToItem(rows[0]) : null;
};

/**
 * Gets all items (across all users) for scheduled sync.
 */
export const getAllItems = async (): Promise<JSONItem[]> => {
  const result = await pool.query<ItemRow>(
    `SELECT * FROM ${ITEMS}
     WHERE (is_deleted IS NULL OR is_deleted = FALSE)`
  );
  return result.rows.map(rowToItem);
};

/**
 * Searches items with optional filters.
 */
export const searchItems = async (
  user: MaskedUser,
  options: {
    item_id?: string;
    institution_id?: string;
    provider?: ItemProvider;
  } = {}
): Promise<JSONItem[]> => {
  const { sql, values } = buildSelectWithFilters(ITEMS, "*", {
    user_id: user.user_id,
    filters: {
      [ITEM_ID]: options.item_id,
      [INSTITUTION_ID]: options.institution_id,
      provider: options.provider,
    },
  });

  const result = await pool.query<ItemRow>(sql, values);
  return result.rows.map(rowToItem);
};

/**
 * Gets item by access token.
 */
export const getItemByAccessToken = async (
  access_token: string
): Promise<JSONItem | null> => {
  const result = await pool.query<ItemRow>(
    `SELECT * FROM ${ITEMS}
     WHERE access_token = $1
     AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [access_token]
  );
  return result.rows.length > 0 ? rowToItem(result.rows[0]) : null;
};

/**
 * Gets items by institution.
 */
export const getItemsByInstitution = async (
  user: MaskedUser,
  institution_id: string
): Promise<JSONItem[]> => {
  const result = await pool.query<ItemRow>(
    `SELECT * FROM ${ITEMS}
     WHERE ${INSTITUTION_ID} = $1 AND ${USER_ID} = $2
     AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [institution_id, user.user_id]
  );
  return result.rows.map(rowToItem);
};

/**
 * Gets an item along with its user information.
 */
export const getUserItem = async (
  item_id: string
): Promise<{ user: MaskedUser; item: JSONItem } | null> => {
  const result = await pool.query<ItemRow & { username: string }>(
    `SELECT i.*, u.username
     FROM ${ITEMS} i
     JOIN users u ON i.${USER_ID} = u.${USER_ID}
     WHERE i.${ITEM_ID} = $1
     AND (i.is_deleted IS NULL OR i.is_deleted = FALSE)`,
    [item_id]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    user: {
      user_id: row.user_id,
      username: row.username,
    },
    item: rowToItem(row),
  };
};

/**
 * Upserts items for a user.
 */
export const upsertItems = async (
  user: MaskedUser,
  items: PartialItem[],
  upsert: boolean = true
): Promise<UpsertResult[]> => {
  if (!items.length) return [];
  const results: UpsertResult[] = [];

  for (const item of items) {
    const row = ItemModel.fromJSON(item, user.user_id);

    try {
      if (upsert) {
        const columns = Object.keys(row);
        const updateColumns = columns.filter(
          (col) => col !== ITEM_ID && col !== USER_ID
        );

        const query = buildUpsert(ITEMS, ITEM_ID, row as Record<string, unknown>, {
          updateColumns,
          returning: [ITEM_ID],
        });

        // Add WHERE clause for user_id check
        const sql = query.sql.replace(
          "DO UPDATE SET",
          `DO UPDATE SET`
        ) + ` WHERE ${ITEMS}.${USER_ID} = '${user.user_id}'`;

        const result = await pool.query(sql, query.values);
        results.push(successResult(item.item_id, result.rowCount));
      } else {
        // Update only
        const updateData = { ...row };
        delete updateData.item_id;
        delete updateData.user_id;

        const query = buildUpdate(
          ITEMS,
          ITEM_ID,
          item.item_id,
          updateData as Record<string, unknown>,
          {
            additionalWhere: { column: USER_ID, value: user.user_id },
            returning: [ITEM_ID],
          }
        );

        if (query) {
          const result = await pool.query(query.sql, query.values);
          results.push(successResult(item.item_id, result.rowCount));
        } else {
          results.push(noChangeResult(item.item_id));
        }
      }
    } catch (error) {
      console.error(`Failed to upsert item ${item.item_id}:`, error);
      results.push(errorResult(item.item_id));
    }
  }

  return results;
};

/**
 * Updates item cursor (for transaction syncing).
 */
export const updateItemCursor = async (
  item_id: string,
  cursor: string
): Promise<boolean> => {
  const result = await pool.query(
    `UPDATE ${ITEMS} SET cursor = $1, updated = CURRENT_TIMESTAMP
     WHERE ${ITEM_ID} = $2
     RETURNING ${ITEM_ID}`,
    [cursor, item_id]
  );
  return (result.rowCount || 0) > 0;
};

/**
 * Updates item status.
 */
export const updateItemStatus = async (
  item_id: string,
  status: string
): Promise<boolean> => {
  const result = await pool.query(
    `UPDATE ${ITEMS} SET status = $1, updated = CURRENT_TIMESTAMP
     WHERE ${ITEM_ID} = $2
     RETURNING ${ITEM_ID}`,
    [status, item_id]
  );
  return (result.rowCount || 0) > 0;
};

/**
 * Deletes a single item with cascade.
 */
export const deleteItem = async (
  user: MaskedUser,
  item_id: string
): Promise<boolean> => {
  const { user_id } = user;

  // Get account IDs for this item
  const accountResult = await pool.query<{ account_id: string }>(
    `SELECT account_id FROM ${ACCOUNTS}
     WHERE ${ITEM_ID} = $1 AND ${USER_ID} = $2
     AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [item_id, user_id]
  );
  const accountIds = accountResult.rows.map((r) => r.account_id);

  if (accountIds.length > 0) {
    const placeholders = accountIds.map((_, i) => `$${i + 2}`).join(", ");

    // Cascade: soft-delete transactions
    await pool.query(
      `UPDATE ${TRANSACTIONS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
       WHERE account_id IN (${placeholders}) AND ${USER_ID} = $1`,
      [user_id, ...accountIds]
    );

    // Cascade: soft-delete investment_transactions
    await pool.query(
      `UPDATE ${INVESTMENT_TRANSACTIONS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
       WHERE account_id IN (${placeholders}) AND ${USER_ID} = $1`,
      [user_id, ...accountIds]
    );

    // Cascade: soft-delete split_transactions
    await pool.query(
      `UPDATE ${SPLIT_TRANSACTIONS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
       WHERE account_id IN (${placeholders}) AND ${USER_ID} = $1`,
      [user_id, ...accountIds]
    );

    // Cascade: soft-delete snapshots
    await pool.query(
      `UPDATE ${SNAPSHOTS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
       WHERE account_id IN (${placeholders}) AND ${USER_ID} = $1`,
      [user_id, ...accountIds]
    );

    // Cascade: soft-delete holdings
    await pool.query(
      `UPDATE ${HOLDINGS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
       WHERE account_id IN (${placeholders}) AND ${USER_ID} = $1`,
      [user_id, ...accountIds]
    );

    // Cascade: soft-delete accounts
    await pool.query(
      `UPDATE ${ACCOUNTS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
       WHERE account_id IN (${placeholders}) AND ${USER_ID} = $1`,
      [user_id, ...accountIds]
    );
  }

  const result = await pool.query(
    `UPDATE ${ITEMS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE ${ITEM_ID} = $1 AND ${USER_ID} = $2
     RETURNING ${ITEM_ID}`,
    [item_id, user_id]
  );
  return (result.rowCount || 0) > 0;
};

/**
 * Deletes multiple items (soft delete).
 */
export const deleteItems = async (
  user: MaskedUser,
  item_ids: string[]
): Promise<{ deleted: number }> => {
  if (!item_ids.length) return { deleted: 0 };

  const placeholders = item_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `UPDATE ${ITEMS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE ${ITEM_ID} IN (${placeholders}) AND ${USER_ID} = $1
     RETURNING ${ITEM_ID}`,
    [user.user_id, ...item_ids]
  );

  return { deleted: result.rowCount || 0 };
};
