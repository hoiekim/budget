import { JSONSuggestion } from "common";
import { pool } from "../client";
import {
  MaskedUser,
  SuggestionModel,
  SUGGESTIONS,
  TRANSACTION_ID,
  USER_ID,
  CATEGORY_ID,
  CONFIDENCE,
  UPDATED,
} from "../models";

/**
 * Read all suggestion rows for a single transaction. Used in tests + by
 * Stage 2's write paths to inspect existing state before transitioning.
 */
export const getSuggestionsForTransaction = async (
  user: MaskedUser,
  transaction_id: string,
): Promise<JSONSuggestion[]> => {
  const sql = `
    SELECT * FROM ${SUGGESTIONS}
    WHERE ${USER_ID} = $1 AND ${TRANSACTION_ID} = $2
    ORDER BY ${CONFIDENCE} DESC
  `;
  const result = await pool.query<Record<string, unknown>>(sql, [
    user.user_id,
    transaction_id,
  ]);
  return result.rows.map((row) => new SuggestionModel(row).toJSON());
};

/**
 * Bulk read suggestion rows across a set of transactions — what
 * `getMerchantSignal` will use (Stage 2) to compute the confirm/reject rate
 * per merchant.
 */
export const getSuggestionsForTransactions = async (
  user: MaskedUser,
  transaction_ids: string[],
): Promise<JSONSuggestion[]> => {
  if (transaction_ids.length === 0) return [];
  const placeholders = transaction_ids.map((_, i) => `$${i + 2}`).join(", ");
  const sql = `
    SELECT * FROM ${SUGGESTIONS}
    WHERE ${USER_ID} = $1 AND ${TRANSACTION_ID} IN (${placeholders})
    ORDER BY ${TRANSACTION_ID}, ${CONFIDENCE} DESC
  `;
  const result = await pool.query<Record<string, unknown>>(sql, [
    user.user_id,
    ...transaction_ids,
  ]);
  return result.rows.map((row) => new SuggestionModel(row).toJSON());
};

/**
 * UPSERT a user-confirmed suggestion at `confidence = 1`. Used when the
 * user accepts or picks a category. The ON CONFLICT clause lets the same
 * (transaction_id, category_id) row transition from any prior confidence
 * (0, 0.x, or 1) up to 1.
 */
export const upsertUserConfirmedSuggestion = async (
  user: MaskedUser,
  transaction_id: string,
  category_id: string,
): Promise<JSONSuggestion | null> => {
  // ON CONFLICT WHERE clause guards user_id — defense-in-depth in case a
  // future bug ever lets two users share a transaction_id (Plaid PK
  // collision in sandbox, manual fixture, etc.). transaction_id is the
  // Plaid PK and globally unique today, but pinning user_id on the upsert
  // keeps an upsert from ever clobbering a different user's row.
  const sql = `
    INSERT INTO ${SUGGESTIONS}
      (${TRANSACTION_ID}, ${USER_ID}, ${CATEGORY_ID}, ${CONFIDENCE})
    VALUES ($1, $2, $3, 1)
    ON CONFLICT (${TRANSACTION_ID}, ${CATEGORY_ID})
    DO UPDATE SET ${CONFIDENCE} = 1, ${UPDATED} = CURRENT_TIMESTAMP
      WHERE ${SUGGESTIONS}.${USER_ID} = $2
    RETURNING *
  `;
  const result = await pool.query<Record<string, unknown>>(sql, [
    transaction_id,
    user.user_id,
    category_id,
  ]);
  return result.rows.length > 0 ? new SuggestionModel(result.rows[0]).toJSON() : null;
};

/**
 * UPSERT an engine suggestion at a strict-fractional confidence. The
 * conflict-resolution guard `WHERE suggestions.confidence < 1 AND
 * suggestions.confidence > 0` means the engine never clobbers a
 * user-confirmed (1) or user-rejected (0) row — it only refreshes the
 * score of a still-engine-owned row.
 */
export const upsertEngineSuggestion = async (
  user: MaskedUser,
  transaction_id: string,
  category_id: string,
  confidence: number,
): Promise<JSONSuggestion | null> => {
  if (confidence <= 0 || confidence >= 1) {
    throw new Error(
      `upsertEngineSuggestion: confidence must be strict-fractional in (0, 1), got ${confidence}`,
    );
  }
  const sql = `
    INSERT INTO ${SUGGESTIONS}
      (${TRANSACTION_ID}, ${USER_ID}, ${CATEGORY_ID}, ${CONFIDENCE})
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (${TRANSACTION_ID}, ${CATEGORY_ID})
    DO UPDATE SET ${CONFIDENCE} = EXCLUDED.${CONFIDENCE}, ${UPDATED} = CURRENT_TIMESTAMP
      WHERE ${SUGGESTIONS}.${USER_ID} = $2
        AND ${SUGGESTIONS}.${CONFIDENCE} < 1
        AND ${SUGGESTIONS}.${CONFIDENCE} > 0
    RETURNING *
  `;
  const result = await pool.query<Record<string, unknown>>(sql, [
    transaction_id,
    user.user_id,
    category_id,
    confidence,
  ]);
  return result.rows.length > 0 ? new SuggestionModel(result.rows[0]).toJSON() : null;
};

/**
 * Demote any engine-suggestion rows for this transaction (confidence in
 * the open interval (0, 1)) to `confidence = 0`.
 *
 * **Important — `confidence = 0` is the rejection sentinel.** Calling this
 * function on a transaction marks every formerly-engine-suggested category
 * for that transaction as user-rejected, because the user just took an
 * action and the engine's prior guesses are no longer current. That is the
 * intended semantic — if the user picks B over A, A's row collapses to a
 * rejection signal the merchant signal can read.
 *
 * Confidence-1 rows (prior user confirmations) and confidence-0 rows
 * (prior user rejections) are unaffected.
 */
export const demoteEngineSuggestionsForTransaction = async (
  user: MaskedUser,
  transaction_id: string,
): Promise<number> => {
  const sql = `
    UPDATE ${SUGGESTIONS}
    SET ${CONFIDENCE} = 0, ${UPDATED} = CURRENT_TIMESTAMP
    WHERE ${USER_ID} = $1
      AND ${TRANSACTION_ID} = $2
      AND ${CONFIDENCE} < 1
      AND ${CONFIDENCE} > 0
  `;
  const result = await pool.query(sql, [user.user_id, transaction_id]);
  return result.rowCount ?? 0;
};

/**
 * Drop any prior user-confirmation row (confidence = 1) for this
 * transaction — the second step in the user-action transition (the user is
 * about to confirm a different category, so the existing confirmation is no
 * longer current).
 */
export const deleteUserConfirmedSuggestionForTransaction = async (
  user: MaskedUser,
  transaction_id: string,
): Promise<number> => {
  const sql = `
    DELETE FROM ${SUGGESTIONS}
    WHERE ${USER_ID} = $1
      AND ${TRANSACTION_ID} = $2
      AND ${CONFIDENCE} = 1
  `;
  const result = await pool.query(sql, [user.user_id, transaction_id]);
  return result.rowCount ?? 0;
};

/** Hard-delete every suggestion row for a transaction (used on tx delete). */
export const deleteAllSuggestionsForTransaction = async (
  user_id: string,
  transaction_id: string,
): Promise<number> => {
  const sql = `DELETE FROM ${SUGGESTIONS} WHERE ${USER_ID} = $1 AND ${TRANSACTION_ID} = $2`;
  const result = await pool.query(sql, [user_id, transaction_id]);
  return result.rowCount ?? 0;
};
