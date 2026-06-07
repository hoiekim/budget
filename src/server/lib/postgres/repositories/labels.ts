import { JSONLabel } from "common";
import { pool } from "../client";
import {
  MaskedUser,
  LabelModel,
  LABELS,
  LABEL_ID,
  PARENT_TYPE,
  PARENT_ID,
  USER_ID,
  CONFIDENCE,
} from "../models";

/**
 * Read all labels for a single parent (transaction or account), ordered by
 * confidence DESC. The caller picks the first row for the `MAX(confidence)`
 * read or iterates the full list for engine-signal aggregation.
 */
export const getLabelsForParent = async (
  user: MaskedUser,
  parent_id: string,
): Promise<JSONLabel[]> => {
  const sql = `
    SELECT * FROM ${LABELS}
    WHERE ${USER_ID} = $1 AND ${PARENT_ID} = $2
    ORDER BY ${CONFIDENCE} DESC
  `;
  const result = await pool.query<Record<string, unknown>>(sql, [user.user_id, parent_id]);
  return result.rows.map((row) => new LabelModel(row).toJSON());
};

/**
 * Bulk read labels for many parents. Used by transaction/account read paths
 * to JOIN-resolve the `label_*` projection in a single round-trip (Stage 2).
 */
export const getLabelsForParents = async (
  user: MaskedUser,
  parent_ids: string[],
): Promise<JSONLabel[]> => {
  if (parent_ids.length === 0) return [];
  const placeholders = parent_ids.map((_, i) => `$${i + 2}`).join(", ");
  const sql = `
    SELECT * FROM ${LABELS}
    WHERE ${USER_ID} = $1 AND ${PARENT_ID} IN (${placeholders})
    ORDER BY ${PARENT_ID}, ${CONFIDENCE} DESC
  `;
  const result = await pool.query<Record<string, unknown>>(sql, [user.user_id, ...parent_ids]);
  return result.rows.map((row) => new LabelModel(row).toJSON());
};

/**
 * Insert or replace a label at a specific (parent_id, confidence). The
 * UNIQUE (parent_id, confidence) constraint forces UPSERT semantics — a
 * second engine suggestion at the same confidence updates the existing row
 * rather than colliding.
 */
export const upsertLabel = async (
  user: MaskedUser,
  label: Omit<JSONLabel, "label_id">,
): Promise<JSONLabel | null> => {
  const sql = `
    INSERT INTO ${LABELS}
      (${PARENT_TYPE}, ${PARENT_ID}, ${USER_ID}, budget_id, category_id, memo, ${CONFIDENCE})
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (${PARENT_ID}, ${CONFIDENCE})
    DO UPDATE SET
      budget_id = EXCLUDED.budget_id,
      category_id = EXCLUDED.category_id,
      memo = EXCLUDED.memo,
      updated = CURRENT_TIMESTAMP
    RETURNING *
  `;
  const result = await pool.query<Record<string, unknown>>(sql, [
    label.parent_type,
    label.parent_id,
    user.user_id,
    label.budget_id,
    label.category_id,
    label.memo,
    label.confidence,
  ]);
  return result.rows.length > 0 ? new LabelModel(result.rows[0]).toJSON() : null;
};

/**
 * Delete every label for a parent at a strict-fractional confidence
 * (`0 < confidence < 1`) — the engine-suggestion rows. Used by user-action
 * write paths (Stage 2) to clear the engine's prior suggestions so the
 * `MAX(confidence)` read resolves to the user's intent.
 */
export const deleteEngineLabelsForParent = async (
  user: MaskedUser,
  parent_id: string,
): Promise<number> => {
  const sql = `
    DELETE FROM ${LABELS}
    WHERE ${USER_ID} = $1
      AND ${PARENT_ID} = $2
      AND ${CONFIDENCE} > 0
      AND ${CONFIDENCE} < 1
  `;
  const result = await pool.query(sql, [user.user_id, parent_id]);
  return result.rowCount ?? 0;
};

/** Delete a specific label by `(parent_id, confidence)`. */
export const deleteLabel = async (
  user: MaskedUser,
  parent_id: string,
  confidence: number,
): Promise<boolean> => {
  const sql = `
    DELETE FROM ${LABELS}
    WHERE ${USER_ID} = $1 AND ${PARENT_ID} = $2 AND ${CONFIDENCE} = $3
  `;
  const result = await pool.query(sql, [user.user_id, parent_id, confidence]);
  return (result.rowCount ?? 0) > 0;
};

/** Hard-delete every label for a parent (used on parent delete). */
export const deleteAllLabelsForParent = async (
  user_id: string,
  parent_id: string,
): Promise<number> => {
  const sql = `DELETE FROM ${LABELS} WHERE ${USER_ID} = $1 AND ${PARENT_ID} = $2`;
  const result = await pool.query(sql, [user_id, parent_id]);
  return result.rowCount ?? 0;
};

export { LABEL_ID, PARENT_TYPE, PARENT_ID, CONFIDENCE };
