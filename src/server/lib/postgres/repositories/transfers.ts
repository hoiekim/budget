import { JSONTransaction } from "common";
import {
  MaskedUser,
  TransactionModel,
  transactionsTable,
  TRANSACTION_ID,
  USER_ID,
  TRANSFER_PAIR_ID,
  TRANSFER_STATUS,
} from "../models";
import { pool } from "../client";
import { logger } from "../../logger";

export interface TransferPair {
  transfer_pair_id: string;
  transactions: JSONTransaction[];
  transfer_status: "suggested" | "confirmed";
}

/**
 * List all transfer pairs for the given user.
 * Returns grouped pairs (each pair has 2 transactions sharing a transfer_pair_id).
 */
export async function getTransfers(user: MaskedUser): Promise<TransferPair[]> {
  const result = await pool.query(
    `SELECT * FROM transactions
     WHERE ${USER_ID} = $1
       AND ${TRANSFER_PAIR_ID} IS NOT NULL
       AND is_deleted = FALSE
     ORDER BY ${TRANSFER_PAIR_ID}, date DESC`,
    [user.user_id],
  );

  const rows = result.rows.map((row) => new TransactionModel(row).toJSON());

  // Group by transfer_pair_id
  const pairMap = new Map<string, JSONTransaction[]>();
  for (const tx of rows) {
    if (!tx.transfer_pair_id) continue;
    if (!pairMap.has(tx.transfer_pair_id)) pairMap.set(tx.transfer_pair_id, []);
    pairMap.get(tx.transfer_pair_id)!.push(tx);
  }

  const pairs: TransferPair[] = [];
  for (const [pairId, transactions] of pairMap.entries()) {
    const status = (transactions[0]?.transfer_status ?? "suggested") as "suggested" | "confirmed";
    pairs.push({ transfer_pair_id: pairId, transactions, transfer_status: status });
  }

  return pairs;
}

/**
 * Pair two transactions as a transfer.
 * Creates a new UUID shared between both transactions.
 * If both already have the same transfer_pair_id, confirms the pair.
 */
export async function pairTransactions(
  user: MaskedUser,
  transaction_id_a: string,
  transaction_id_b: string,
  confirm = false,
): Promise<{ transfer_pair_id: string } | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Verify ownership of both transactions
    const check = await client.query(
      `SELECT ${TRANSACTION_ID}, ${TRANSFER_PAIR_ID} FROM transactions
       WHERE ${TRANSACTION_ID} = ANY($1)
         AND ${USER_ID} = $2
         AND is_deleted = FALSE`,
      [[transaction_id_a, transaction_id_b], user.user_id],
    );

    if (check.rows.length !== 2) {
      await client.query("ROLLBACK");
      logger.warn("pairTransactions: one or both transactions not found", {
        transaction_id_a,
        transaction_id_b,
        user_id: user.user_id,
      });
      return null;
    }

    // Reuse existing pair_id if already set to same value, otherwise generate new
    const existingIds = check.rows.map((r: { transfer_pair_id: string | null }) => r.transfer_pair_id).filter(Boolean);
    const allSame = existingIds.length === 2 && existingIds[0] === existingIds[1];
    const pairId: string = allSame && existingIds[0] ? existingIds[0] : crypto.randomUUID();
    const status = confirm || allSame ? "confirmed" : "suggested";

    await client.query(
      `UPDATE transactions
       SET ${TRANSFER_PAIR_ID} = $1, ${TRANSFER_STATUS} = $2
       WHERE ${TRANSACTION_ID} = ANY($3) AND ${USER_ID} = $4`,
      [pairId, status, [transaction_id_a, transaction_id_b], user.user_id],
    );

    await client.query("COMMIT");
    return { transfer_pair_id: pairId };
  } catch (err) {
    await client.query("ROLLBACK");
    logger.error("pairTransactions: transaction failed", { err });
    return null;
  } finally {
    client.release();
  }
}

/**
 * Remove a transfer pairing by transfer_pair_id.
 * Nulls out transfer_pair_id and transfer_status on both transactions.
 */
export async function unpairTransactions(
  user: MaskedUser,
  transfer_pair_id: string,
): Promise<{ removed: number } | null> {
  try {
    const result = await pool.query(
      `UPDATE transactions
       SET ${TRANSFER_PAIR_ID} = NULL, ${TRANSFER_STATUS} = NULL
       WHERE ${TRANSFER_PAIR_ID} = $1 AND ${USER_ID} = $2`,
      [transfer_pair_id, user.user_id],
    );
    return { removed: result.rowCount ?? 0 };
  } catch (err) {
    logger.error("unpairTransactions: failed", { err });
    return null;
  }
}
