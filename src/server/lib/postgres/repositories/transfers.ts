import { JSONTransaction, JSONTransferPair, TransferPairStatus } from "common";
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
 * Pair two transactions as a transfer. Single INSERT into transaction_pairs.
 * Pair ids are canonicalized so (a, b) and (b, a) hash to the same row.
 */
export const pairTransactions = async (
  user: MaskedUser,
  transaction_id_a: string,
  transaction_id_b: string,
  status: TransferPairStatus = "suggested",
): Promise<string> => {
  const pair_id = crypto.randomUUID();
  const canonical = canonicalizePairIds(transaction_id_a, transaction_id_b);

  await pool.query(
    `INSERT INTO ${TRANSACTION_PAIRS}
       (${PAIR_ID}, ${USER_ID}, ${TRANSACTION_ID_A}, ${TRANSACTION_ID_B}, ${STATUS})
     VALUES ($1, $2, $3, $4, $5)`,
    [pair_id, user.user_id, canonical.transaction_id_a, canonical.transaction_id_b, status],
  );

  return pair_id;
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
 * Remove a transfer pairing — soft-delete the pair row.
 */
export const removeTransferPair = async (
  user: MaskedUser,
  pair_id: string,
): Promise<void> => {
  await pool.query(
    `UPDATE ${TRANSACTION_PAIRS}
     SET ${IS_DELETED} = TRUE, updated = CURRENT_TIMESTAMP
     WHERE ${PAIR_ID} = $1
       AND ${USER_ID} = $2`,
    [pair_id, user.user_id],
  );
};
