import { JSONRejectedCategory } from "common";
import {
  MaskedUser,
  RejectedCategoryModel,
  REJECTED_CATEGORIES,
  TRANSACTION_ID,
  USER_ID,
  CATEGORY_ID,
  REJECTED_AT,
  pool,
} from "server";

/**
 * Record a user's rejection of `category_id` for `transaction_id`. UPSERT
 * so a re-reject of the same pair just refreshes the timestamp.
 *
 * The `WHERE user_id = $2` on the ON CONFLICT DO UPDATE branch is
 * defense-in-depth — transaction_id is globally unique today, but if a
 * future schema change ever lets two users share a transaction_id, this
 * guard prevents cross-user clobber.
 */
export const addRejectedCategory = async (
  user: MaskedUser,
  transaction_id: string,
  category_id: string,
): Promise<JSONRejectedCategory | null> => {
  const sql = `
    INSERT INTO ${REJECTED_CATEGORIES}
      (${TRANSACTION_ID}, ${USER_ID}, ${CATEGORY_ID})
    VALUES ($1, $2, $3)
    ON CONFLICT (${TRANSACTION_ID}, ${CATEGORY_ID})
    DO UPDATE SET ${REJECTED_AT} = CURRENT_TIMESTAMP
      WHERE ${REJECTED_CATEGORIES}.${USER_ID} = $2
    RETURNING *
  `;
  const result = await pool.query<Record<string, unknown>>(sql, [
    transaction_id,
    user.user_id,
    category_id,
  ]);
  return result.rows.length > 0
    ? new RejectedCategoryModel(result.rows[0]).toJSON()
    : null;
};

/**
 * Clear a rejection row — used when the user later confirms the same
 * category they once rejected ("changed my mind").
 */
export const removeRejectedCategory = async (
  user: MaskedUser,
  transaction_id: string,
  category_id: string,
): Promise<number> => {
  const sql = `
    DELETE FROM ${REJECTED_CATEGORIES}
    WHERE ${USER_ID} = $1
      AND ${TRANSACTION_ID} = $2
      AND ${CATEGORY_ID} = $3
  `;
  const result = await pool.query(sql, [user.user_id, transaction_id, category_id]);
  return result.rowCount ?? 0;
};

/**
 * Bulk read rejection rows across a set of transactions — used by
 * `getMerchantSignal` (Stage 2b) to count rejections per (merchant,
 * category).
 */
export const getRejectedCategoriesForTransactions = async (
  user: MaskedUser,
  transaction_ids: string[],
): Promise<JSONRejectedCategory[]> => {
  if (transaction_ids.length === 0) return [];
  const placeholders = transaction_ids.map((_, i) => `$${i + 2}`).join(", ");
  const sql = `
    SELECT ${TRANSACTION_ID}, ${USER_ID}, ${CATEGORY_ID}, ${REJECTED_AT}
    FROM ${REJECTED_CATEGORIES}
    WHERE ${USER_ID} = $1 AND ${TRANSACTION_ID} IN (${placeholders})
    ORDER BY ${TRANSACTION_ID}, ${REJECTED_AT} DESC
  `;
  const result = await pool.query<Record<string, unknown>>(sql, [
    user.user_id,
    ...transaction_ids,
  ]);
  return result.rows.map((row) => new RejectedCategoryModel(row).toJSON());
};
