import { JSONItem } from "common";
import { pool } from "./client";
import { MaskedUser } from "./users";

export type PartialItem = { item_id: string } & Partial<JSONItem>;

/**
 * Converts an ES-style item object to Postgres columns.
 */
function itemToRow(item: PartialItem): Record<string, any> {
  const row: Record<string, any> = {};
  
  if (item.item_id !== undefined) row.item_id = item.item_id;
  if (item.access_token !== undefined) row.access_token = item.access_token;
  if (item.institution_id !== undefined) row.institution_id = item.institution_id;
  if (item.available_products !== undefined) row.available_products = item.available_products;
  if (item.cursor !== undefined) row.cursor = item.cursor;
  if (item.status !== undefined) row.status = item.status;
  if (item.provider !== undefined) row.provider = item.provider;
  
  return row;
}

/**
 * Converts a Postgres row to ES-style item object.
 */
function rowToItem(row: Record<string, any>): JSONItem {
  return {
    item_id: row.item_id,
    user_id: row.user_id,
    access_token: row.access_token,
    institution_id: row.institution_id,
    available_products: row.available_products,
    cursor: row.cursor,
    updated: row.updated,
    status: row.status,
    provider: row.provider,
  } as JSONItem;
}

/**
 * Updates or inserts items associated with given user.
 */
export const upsertItems = async (
  user: MaskedUser,
  items: PartialItem[],
  upsert: boolean = true
) => {
  if (!items.length) return [];
  const { user_id } = user;
  const results: { update: { _id: string }; status: number }[] = [];

  for (const item of items) {
    const row = itemToRow(item);
    row.user_id = user_id;
    
    try {
      if (upsert) {
        const columns = Object.keys(row);
        const values = Object.values(row);
        const placeholders = values.map((_, i) => `$${i + 1}`);
        
        const updateClauses = columns
          .filter(col => col !== "item_id" && col !== "user_id")
          .map(col => `${col} = EXCLUDED.${col}`);
        updateClauses.push("updated = CURRENT_TIMESTAMP");
        
        const query = `
          INSERT INTO items (${columns.join(", ")}, updated)
          VALUES (${placeholders.join(", ")}, CURRENT_TIMESTAMP)
          ON CONFLICT (item_id) DO UPDATE SET
            ${updateClauses.join(", ")}
          WHERE items.user_id = $${columns.indexOf("user_id") + 1}
          RETURNING item_id
        `;
        
        const result = await pool.query(query, values);
        results.push({
          update: { _id: item.item_id },
          status: result.rowCount ? 200 : 404,
        });
      } else {
        // Update only
        const updateData = { ...row };
        delete updateData.item_id;
        delete updateData.user_id;
        
        const setClauses: string[] = ["updated = CURRENT_TIMESTAMP"];
        const values: any[] = [];
        let paramIndex = 1;
        
        for (const [key, value] of Object.entries(updateData)) {
          if (value !== undefined) {
            setClauses.push(`${key} = $${paramIndex}`);
            values.push(value);
            paramIndex++;
          }
        }
        
        if (setClauses.length > 1) {
          values.push(item.item_id, user_id);
          const query = `
            UPDATE items SET ${setClauses.join(", ")}
            WHERE item_id = $${paramIndex} AND user_id = $${paramIndex + 1}
            RETURNING item_id
          `;
          
          const result = await pool.query(query, values);
          results.push({
            update: { _id: item.item_id },
            status: result.rowCount ? 200 : 404,
          });
        } else {
          results.push({
            update: { _id: item.item_id },
            status: 304,
          });
        }
      }
    } catch (error: any) {
      console.error(`Failed to upsert item ${item.item_id}:`, error.message);
      results.push({
        update: { _id: item.item_id },
        status: 500,
      });
    }
  }

  return results;
};

/**
 * Retrieves all items for a user.
 */
export const getItems = async (user: MaskedUser): Promise<JSONItem[]> => {
  const { user_id } = user;
  const result = await pool.query(
    `SELECT * FROM items WHERE user_id = $1 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [user_id]
  );
  return result.rows.map(rowToItem);
};

/**
 * Retrieves a single item by ID.
 */
export const getItem = async (
  user: MaskedUser,
  item_id: string
): Promise<JSONItem | null> => {
  const { user_id } = user;
  const result = await pool.query(
    `SELECT * FROM items WHERE item_id = $1 AND user_id = $2 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [item_id, user_id]
  );
  return result.rows.length > 0 ? rowToItem(result.rows[0]) : null;
};

/**
 * Gets item by access token.
 */
export const getItemByAccessToken = async (
  access_token: string
): Promise<JSONItem | null> => {
  const result = await pool.query(
    `SELECT * FROM items WHERE access_token = $1 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [access_token]
  );
  return result.rows.length > 0 ? rowToItem(result.rows[0]) : null;
};

/**
 * Deletes items (soft delete).
 */
export const deleteItems = async (
  user: MaskedUser,
  item_ids: string[]
): Promise<{ deleted: number }> => {
  if (!item_ids.length) return { deleted: 0 };
  const { user_id } = user;
  
  const placeholders = item_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `UPDATE items SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP 
     WHERE item_id IN (${placeholders}) AND user_id = $1
     RETURNING item_id`,
    [user_id, ...item_ids]
  );
  
  return { deleted: result.rowCount || 0 };
};

/**
 * Updates item cursor (for transaction syncing).
 */
export const updateItemCursor = async (
  item_id: string,
  cursor: string
): Promise<boolean> => {
  const result = await pool.query(
    `UPDATE items SET cursor = $1, updated = CURRENT_TIMESTAMP WHERE item_id = $2 RETURNING item_id`,
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
    `UPDATE items SET status = $1, updated = CURRENT_TIMESTAMP WHERE item_id = $2 RETURNING item_id`,
    [status, item_id]
  );
  return (result.rowCount || 0) > 0;
};

/**
 * Gets items by institution.
 */
export const getItemsByInstitution = async (
  user: MaskedUser,
  institution_id: string
): Promise<JSONItem[]> => {
  const { user_id } = user;
  const result = await pool.query(
    `SELECT * FROM items 
     WHERE institution_id = $1 AND user_id = $2 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [institution_id, user_id]
  );
  return result.rows.map(rowToItem);
};
