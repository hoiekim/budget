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
 * Migrate rejection rows from a pending Plaid transaction_id onto the
 * posted transaction_id that supersedes it.
 *
 * When Plaid transitions a transaction from pending → posted, the
 * stored row keeps its OLD `transaction_id` (the pending id) and a NEW
 * row is created with the POSTED id. Any rejection rows the user
 * recorded while the transaction was pending stay attached to the OLD
 * id and become orphaned signal from the engine's point of view (it
 * scans by transaction_id matching the current merchant join).
 *
 * This migrates them in-place: copy rows from `pending` → `posted` with
 * `ON CONFLICT DO NOTHING` (in case the posted id already has its own
 * rejection rows), then delete the original pending-side rows. Runs in
 * a single transaction so a partial failure can't leave both copies
 * present.
 *
 * Returns the number of rows migrated.
 */
export const migrateRejectedCategoriesOnPendingPosted = async (
  pending_transaction_id: string,
  posted_transaction_id: string,
): Promise<number> => {
  if (pending_transaction_id === posted_transaction_id) return 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const copyResult = await client.query(
      `
      INSERT INTO ${REJECTED_CATEGORIES}
        (${TRANSACTION_ID}, ${USER_ID}, ${CATEGORY_ID}, ${REJECTED_AT})
      SELECT $1, ${USER_ID}, ${CATEGORY_ID}, ${REJECTED_AT}
      FROM ${REJECTED_CATEGORIES}
      WHERE ${TRANSACTION_ID} = $2
      ON CONFLICT (${TRANSACTION_ID}, ${CATEGORY_ID}) DO NOTHING
      `,
      [posted_transaction_id, pending_transaction_id],
    );
    await client.query(`DELETE FROM ${REJECTED_CATEGORIES} WHERE ${TRANSACTION_ID} = $1`, [
      pending_transaction_id,
    ]);
    await client.query("COMMIT");
    return copyResult.rowCount ?? 0;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
