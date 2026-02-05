import { JSONCapacity } from "common";
import { pool } from "./client";
import { MaskedUser } from "./users";

export type ParentType = "budget" | "section" | "category";

interface CapacityRow {
  capacity_id: string;
  user_id: string;
  parent_id: string;
  parent_type: ParentType;
  month: number;
  active_from: string | Date | null;
  updated: Date;
  is_deleted: boolean;
}

function rowToCapacity(row: CapacityRow): JSONCapacity {
  return {
    capacity_id: row.capacity_id,
    month: row.month != null ? Number(row.month) : 0,
    active_from: row.active_from
      ? row.active_from instanceof Date
        ? row.active_from.toISOString()
        : row.active_from
      : undefined,
  };
}

/**
 * Gets capacities for a single parent entity.
 */
export const getCapacitiesByParent = async (
  parent_id: string,
  parent_type: ParentType
): Promise<JSONCapacity[]> => {
  const result = await pool.query(
    `SELECT * FROM capacities
     WHERE parent_id = $1 AND parent_type = $2 AND (is_deleted IS NULL OR is_deleted = FALSE)
     ORDER BY active_from ASC NULLS FIRST`,
    [parent_id, parent_type]
  );
  return result.rows.map(rowToCapacity);
};

/**
 * Gets capacities for multiple parent entities (batch, for efficiency).
 * Returns a map of parent_id → JSONCapacity[].
 */
export const getCapacitiesByParents = async (
  parent_ids: string[],
  parent_type: ParentType
): Promise<Map<string, JSONCapacity[]>> => {
  const map = new Map<string, JSONCapacity[]>();
  if (!parent_ids.length) return map;

  const placeholders = parent_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `SELECT * FROM capacities
     WHERE parent_id IN (${placeholders}) AND parent_type = $1 AND (is_deleted IS NULL OR is_deleted = FALSE)
     ORDER BY active_from ASC NULLS FIRST`,
    [parent_type, ...parent_ids]
  );

  for (const row of result.rows) {
    const parentId = row.parent_id;
    if (!map.has(parentId)) map.set(parentId, []);
    map.get(parentId)!.push(rowToCapacity(row));
  }

  return map;
};

/**
 * Upserts capacities for a parent entity.
 * Handles insert/update by capacity_id, and soft-deletes removed capacities.
 */
export const upsertCapacities = async (
  user: MaskedUser,
  parent_id: string,
  parent_type: ParentType,
  capacities: JSONCapacity[]
): Promise<void> => {
  const { user_id } = user;

  // Get existing capacity IDs for this parent
  const existingResult = await pool.query(
    `SELECT capacity_id FROM capacities
     WHERE parent_id = $1 AND parent_type = $2 AND user_id = $3 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [parent_id, parent_type, user_id]
  );
  const existingIds = new Set(existingResult.rows.map((r: any) => r.capacity_id));

  const incomingIds = new Set<string>();

  for (const cap of capacities) {
    incomingIds.add(cap.capacity_id);

    await pool.query(
      `INSERT INTO capacities (capacity_id, user_id, parent_id, parent_type, month, active_from, updated)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
       ON CONFLICT (capacity_id) DO UPDATE SET
         month = $5,
         active_from = $6,
         is_deleted = FALSE,
         updated = CURRENT_TIMESTAMP`,
      [
        cap.capacity_id,
        user_id,
        parent_id,
        parent_type,
        cap.month,
        cap.active_from || null,
      ]
    );
  }

  // Soft-delete capacities that were removed
  for (const existingId of existingIds) {
    if (!incomingIds.has(existingId)) {
      await pool.query(
        `UPDATE capacities SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
         WHERE capacity_id = $1 AND user_id = $2`,
        [existingId, user_id]
      );
    }
  }
};

/**
 * Soft-deletes all capacities for a parent entity.
 */
export const deleteCapacitiesByParent = async (
  user: MaskedUser,
  parent_id: string
): Promise<void> => {
  const { user_id } = user;
  await pool.query(
    `UPDATE capacities SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE parent_id = $1 AND user_id = $2 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [parent_id, user_id]
  );
};
