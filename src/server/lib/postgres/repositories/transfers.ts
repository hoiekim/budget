import { JSONTransaction, TransferPairStatus } from "common";
import { pool } from "../client";
import {
  MaskedUser,
  TransactionModel,
  TransactionPairModel,
  TRANSACTIONS,
  TRANSACTION_PAIRS,
  USER_ID,
  PAIR_ID,
  TRANSACTION_ID_A,
  TRANSACTION_ID_B,
  STATUS,
  IS_DELETED,
  canonicalizePairIds,
} from "../models";

const TRANSACTION_ID = "transaction_id";

export interface TransferPair {
  pair_id: string;
  status: TransferPairStatus;
  transactions: JSONTransaction[];
}

/**
 * Get all transfer pairs for a user. JOINs the pairs table to the two
 * transactions referenced by each pair so the response shape stays the same
 * as before (one entry per pair, with the two paired transactions inline).
 */
export const getTransferPairs = async (user: MaskedUser): Promise<TransferPair[]> => {
  const pairsResult = await pool.query<Record<string, unknown>>(
    `SELECT * FROM ${TRANSACTION_PAIRS}
     WHERE ${USER_ID} = $1
       AND (${IS_DELETED} IS NULL OR ${IS_DELETED} = FALSE)
     ORDER BY ${PAIR_ID}`,
    [user.user_id],
  );

  if (pairsResult.rows.length === 0) return [];

  const pairs = pairsResult.rows.map((row) => new TransactionPairModel(row));
  const txnIds = pairs.flatMap((p) => [p.transaction_id_a, p.transaction_id_b]);

  const txnsResult = await pool.query<Record<string, unknown>>(
    `SELECT * FROM ${TRANSACTIONS}
     WHERE ${USER_ID} = $1
       AND ${TRANSACTION_ID} = ANY($2::text[])
       AND (${IS_DELETED} IS NULL OR ${IS_DELETED} = FALSE)`,
    [user.user_id, txnIds],
  );

  const txnById = new Map<string, JSONTransaction>();
  for (const row of txnsResult.rows) {
    const tx = new TransactionModel(row).toJSON();
    txnById.set(tx.transaction_id, tx);
  }

  return pairs
    .map((pair): TransferPair | null => {
      const a = txnById.get(pair.transaction_id_a);
      const b = txnById.get(pair.transaction_id_b);
      if (!a || !b) return null;
      return {
        pair_id: pair.pair_id,
        status: pair.status,
        transactions: [a, b],
      };
    })
    .filter((p): p is TransferPair => p !== null);
};

/**
 * Pair two transactions as a transfer. INSERT into transaction_pairs with
 * ON CONFLICT handling so re-pairing a previously soft-deleted pair undeletes
 * the existing row instead of failing the UNIQUE (a, b) constraint. An active
 * (non-deleted) row's status is preserved — repeat suggestions don't downgrade
 * a manually confirmed pair. Returns the effective pair_id (existing or new).
 */
export const pairTransactions = async (
  user: MaskedUser,
  transaction_id_a: string,
  transaction_id_b: string,
  status: TransferPairStatus = "suggested",
): Promise<string> => {
  const pair_id = crypto.randomUUID();
  const canonical = canonicalizePairIds(transaction_id_a, transaction_id_b);

  const result = await pool.query<{ pair_id: string }>(
    `INSERT INTO ${TRANSACTION_PAIRS}
       (${PAIR_ID}, ${USER_ID}, ${TRANSACTION_ID_A}, ${TRANSACTION_ID_B}, ${STATUS})
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (${TRANSACTION_ID_A}, ${TRANSACTION_ID_B}) DO UPDATE SET
       ${STATUS} = CASE
         WHEN ${TRANSACTION_PAIRS}.${IS_DELETED} = TRUE THEN EXCLUDED.${STATUS}
         ELSE ${TRANSACTION_PAIRS}.${STATUS}
       END,
       ${IS_DELETED} = FALSE,
       updated = CASE
         WHEN ${TRANSACTION_PAIRS}.${IS_DELETED} = TRUE THEN CURRENT_TIMESTAMP
         ELSE ${TRANSACTION_PAIRS}.updated
       END
     RETURNING ${PAIR_ID}`,
    [pair_id, user.user_id, canonical.transaction_id_a, canonical.transaction_id_b, status],
  );

  return result.rows[0].pair_id;
};

/**
 * Confirm a suggested transfer pair. UPDATE one row by pair_id.
 */
export const confirmTransferPair = async (
  user: MaskedUser,
  pair_id: string,
): Promise<void> => {
  await pool.query(
    `UPDATE ${TRANSACTION_PAIRS}
     SET ${STATUS} = 'confirmed', updated = CURRENT_TIMESTAMP
     WHERE ${PAIR_ID} = $1
       AND ${USER_ID} = $2
       AND (${IS_DELETED} IS NULL OR ${IS_DELETED} = FALSE)`,
    [pair_id, user.user_id],
  );
};

/**
 * Reject a transfer pairing — marks the pair `status = 'rejected'` so the
 * suggestion engine remembers the user's "no" and won't re-suggest THIS
 * specific pair on future runs. The pair row stays present (is_deleted
 * = FALSE) so the rejection is queryable; the two transactions remain
 * eligible to be paired with OTHER counterparts.
 *
 * Distinct from soft-deletion (`is_deleted = TRUE`): soft-deletion is
 * the system-side cascade when one of the paired transactions itself
 * gets removed (Plaid tombstone, manual delete) — it has no user-intent
 * semantics and the surviving transaction is fully eligible for new
 * suggestions, including the same counterpart if it returns.
 *
 * Naming: function was previously `removeTransferPair` (soft-delete);
 * renamed to reflect the actual semantics now that rejection and
 * deletion are distinct.
 */
export const rejectTransferPair = async (
  user: MaskedUser,
  pair_id: string,
): Promise<void> => {
  await pool.query(
    `UPDATE ${TRANSACTION_PAIRS}
     SET ${STATUS} = 'rejected', updated = CURRENT_TIMESTAMP
     WHERE ${PAIR_ID} = $1
       AND ${USER_ID} = $2
       AND (${IS_DELETED} IS NULL OR ${IS_DELETED} = FALSE)`,
    [pair_id, user.user_id],
  );
};
