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
  IS_CONFIRMED,
  IS_REJECTED,
  CONFIRMED_AT,
  ENGINE_SCORED_AT,
  UPDATED,
} from "../models";

/**
 * Read all suggestion rows for a single transaction. Used in tests + by
 * Stage 2 to inspect existing state before transitioning.
 */
export const getSuggestionsForTransaction = async (
  user: MaskedUser,
  transaction_id: string,
): Promise<JSONSuggestion[]> => {
  const sql = `
    SELECT * FROM ${SUGGESTIONS}
    WHERE ${USER_ID} = $1 AND ${TRANSACTION_ID} = $2
    ORDER BY ${IS_CONFIRMED} DESC, ${CONFIDENCE} DESC
  `;
  const result = await pool.query<Record<string, unknown>>(sql, [
    user.user_id,
    transaction_id,
  ]);
  return result.rows.map((row) => new SuggestionModel(row).toJSON());
};

/**
 * Bulk read suggestion rows across a set of transactions — what
 * `getMerchantSignal` will use (Stage 2) to compute the confirm/reject
 * rate per merchant.
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
    ORDER BY ${TRANSACTION_ID}, ${IS_CONFIRMED} DESC, ${CONFIDENCE} DESC
  `;
  const result = await pool.query<Record<string, unknown>>(sql, [
    user.user_id,
    ...transaction_ids,
  ]);
  return result.rows.map((row) => new SuggestionModel(row).toJSON());
};

/**
 * UPSERT a user-confirmed suggestion: sets `is_confirmed = TRUE`,
 * `is_rejected = FALSE`, `confirmed_at = NOW()`. Engine score (if any)
 * is preserved for history. ON CONFLICT lets the same (transaction_id,
 * category_id) row transition from engine-owned to user-confirmed
 * without changing `confidence`.
 */
export const upsertUserConfirmedSuggestion = async (
  user: MaskedUser,
  transaction_id: string,
  category_id: string,
): Promise<JSONSuggestion | null> => {
  const sql = `
    INSERT INTO ${SUGGESTIONS}
      (${TRANSACTION_ID}, ${USER_ID}, ${CATEGORY_ID}, ${CONFIDENCE},
       ${IS_CONFIRMED}, ${IS_REJECTED}, ${CONFIRMED_AT})
    VALUES ($1, $2, $3, 1, TRUE, FALSE, CURRENT_TIMESTAMP)
    ON CONFLICT (${TRANSACTION_ID}, ${CATEGORY_ID})
    DO UPDATE SET
      ${IS_CONFIRMED} = TRUE,
      ${IS_REJECTED} = FALSE,
      ${CONFIRMED_AT} = CURRENT_TIMESTAMP,
      ${UPDATED} = CURRENT_TIMESTAMP
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
 * UPSERT a user-rejected suggestion: sets `is_rejected = TRUE`,
 * `is_confirmed = FALSE`. Confidence is preserved (or seeded to 0 on
 * INSERT) — the merchant signal reads `is_rejected` directly, not
 * confidence.
 */
export const upsertUserRejectedSuggestion = async (
  user: MaskedUser,
  transaction_id: string,
  category_id: string,
): Promise<JSONSuggestion | null> => {
  const sql = `
    INSERT INTO ${SUGGESTIONS}
      (${TRANSACTION_ID}, ${USER_ID}, ${CATEGORY_ID}, ${CONFIDENCE},
       ${IS_CONFIRMED}, ${IS_REJECTED})
    VALUES ($1, $2, $3, 0, FALSE, TRUE)
    ON CONFLICT (${TRANSACTION_ID}, ${CATEGORY_ID})
    DO UPDATE SET
      ${IS_REJECTED} = TRUE,
      ${IS_CONFIRMED} = FALSE,
      ${UPDATED} = CURRENT_TIMESTAMP
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
 * UPSERT an engine suggestion at a strict-fractional confidence. Sets
 * `engine_scored_at = NOW()`. The `WHERE NOT is_confirmed AND NOT
 * is_rejected` guard on ON CONFLICT means the engine never overwrites a
 * user-actioned row — it only refreshes the score on a still-engine-owned
 * row.
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
      (${TRANSACTION_ID}, ${USER_ID}, ${CATEGORY_ID}, ${CONFIDENCE}, ${ENGINE_SCORED_AT})
    VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
    ON CONFLICT (${TRANSACTION_ID}, ${CATEGORY_ID})
    DO UPDATE SET
      ${CONFIDENCE} = EXCLUDED.${CONFIDENCE},
      ${ENGINE_SCORED_AT} = CURRENT_TIMESTAMP,
      ${UPDATED} = CURRENT_TIMESTAMP
      WHERE ${SUGGESTIONS}.${USER_ID} = $2
        AND NOT ${SUGGESTIONS}.${IS_CONFIRMED}
        AND NOT ${SUGGESTIONS}.${IS_REJECTED}
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

/** Hard-delete every suggestion row for a transaction (used on tx delete). */
export const deleteAllSuggestionsForTransaction = async (
  user_id: string,
  transaction_id: string,
): Promise<number> => {
  const sql = `DELETE FROM ${SUGGESTIONS} WHERE ${USER_ID} = $1 AND ${TRANSACTION_ID} = $2`;
  const result = await pool.query(sql, [user_id, transaction_id]);
  return result.rowCount ?? 0;
};
