import { JSONTransaction } from "common";
import { pool } from "../client";
import { MaskedUser, TransactionModel, TRANSACTIONS, USER_ID, TRANSFER_PAIR_ID, TRANSFER_STATUS } from "../models";

const TRANSACTION_ID = "transaction_id";

export interface TransferPair {
  transfer_pair_id: string;
  status: "suggested" | "confirmed";
  transactions: JSONTransaction[];
}

/**
 * Get all transfer pairs for a user.
 * Returns pairs grouped by transfer_pair_id.
 */
export const getTransferPairs = async (user: MaskedUser): Promise<TransferPair[]> => {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT * FROM ${TRANSACTIONS}
     WHERE ${USER_ID} = $1
       AND ${TRANSFER_PAIR_ID} IS NOT NULL
       AND (is_deleted IS NULL OR is_deleted = FALSE)
     ORDER BY ${TRANSFER_PAIR_ID}, date DESC`,
    [user.user_id]
  );

  const pairMap = new Map<string, TransferPair>();
  for (const row of result.rows) {
    const tx = new TransactionModel(row).toJSON();
    const pairId = tx.transfer_pair_id!;
    if (!pairMap.has(pairId)) {
      pairMap.set(pairId, {
        transfer_pair_id: pairId,
        status: (tx.transfer_status as "suggested" | "confirmed") ?? "suggested",
        transactions: [],
      });
    }
    pairMap.get(pairId)!.transactions.push(tx);
  }

  return Array.from(pairMap.values());
};

/**
 * Pair two transactions as a transfer.
 * Generates a shared UUID and sets status on both.
 */
export const pairTransactions = async (
  user: MaskedUser,
  transaction_id_a: string,
  transaction_id_b: string,
  status: "suggested" | "confirmed" = "suggested"
): Promise<string> => {
  const pair_id = crypto.randomUUID();

  await pool.query(
    `UPDATE ${TRANSACTIONS}
     SET ${TRANSFER_PAIR_ID} = $1, ${TRANSFER_STATUS} = $2
     WHERE ${TRANSACTION_ID} = ANY($3::text[])
       AND ${USER_ID} = $4
       AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [pair_id, status, [transaction_id_a, transaction_id_b], user.user_id]
  );

  return pair_id;
};

/**
 * Confirm an existing suggested transfer pair.
 */
export const confirmTransferPair = async (
  user: MaskedUser,
  transfer_pair_id: string
): Promise<void> => {
  await pool.query(
    `UPDATE ${TRANSACTIONS}
     SET ${TRANSFER_STATUS} = 'confirmed'
     WHERE ${TRANSFER_PAIR_ID} = $1
       AND ${USER_ID} = $2
       AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [transfer_pair_id, user.user_id]
  );
};

/**
 * Remove a transfer pairing — nulls out both sides.
 */
export const removeTransferPair = async (
  user: MaskedUser,
  transfer_pair_id: string
): Promise<void> => {
  await pool.query(
    `UPDATE ${TRANSACTIONS}
     SET ${TRANSFER_PAIR_ID} = NULL, ${TRANSFER_STATUS} = NULL
     WHERE ${TRANSFER_PAIR_ID} = $1
       AND ${USER_ID} = $2`,
    [transfer_pair_id, user.user_id]
  );
};
