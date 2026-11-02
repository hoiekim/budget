import { JSONSplitTransaction } from "common";
import { SPLIT_TRANSACTIONS } from "common/constants";
import { pool } from "../client";
import {
  MaskedUser,
  SplitTransactionModel,
  splitTransactionsTable,
  SPLIT_TRANSACTION_ID,
  TRANSACTION_ID,
  ACCOUNT_ID,
  USER_ID,
  UPDATED,
  DATE,
  IS_DELETED,
  QueryExecutor,
} from "../models";
import { UpsertResult, successResult, errorResult, noChangeResult } from "../database";
import { logger } from "../../logger";

export interface SearchSplitTransactionsOptions {
  transaction_id?: string;
  account_id?: string;
  startDate?: string;
  endDate?: string;
  /** When true, soft-deleted (`is_deleted = TRUE`) rows are INCLUDED in
   *  the response so the client can treat them as tombstones and evict
   *  them from its local cache. Defaults to `false`. */
  includeDeleted?: boolean;
}

export type PartialSplitTransaction = {
  split_transaction_id: string;
} & Partial<JSONSplitTransaction>;

export const getSplitTransactions = async (user: MaskedUser): Promise<JSONSplitTransaction[]> => {
  const models = await splitTransactionsTable.query({ [USER_ID]: user.user_id });
  return models.map((m) => m.toJSON());
};

export const getSplitTransaction = async (
  user: MaskedUser,
  split_transaction_id: string,
): Promise<JSONSplitTransaction | null> => {
  const model = await splitTransactionsTable.queryOne({
    [USER_ID]: user.user_id,
    [SPLIT_TRANSACTION_ID]: split_transaction_id,
  });
  return model?.toJSON() ?? null;
};

export const getSplitTransactionsByTransaction = async (
  user: MaskedUser,
  transaction_id: string,
): Promise<JSONSplitTransaction[]> => {
  const models = await splitTransactionsTable.query({
    [USER_ID]: user.user_id,
    [TRANSACTION_ID]: transaction_id,
  });
  return models.map((m) => m.toJSON());
};

export const searchSplitTransactions = async (
  user: MaskedUser,
  options: SearchSplitTransactionsOptions = {},
): Promise<JSONSplitTransaction[]> => {
  const filters: Record<string, unknown> = { [USER_ID]: user.user_id };
  if (options.transaction_id) filters[TRANSACTION_ID] = options.transaction_id;
  if (options.account_id) filters[ACCOUNT_ID] = options.account_id;

  const models = await splitTransactionsTable.query(filters, {
    dateRange:
      options.startDate || options.endDate
        ? { column: UPDATED, start: options.startDate, end: options.endDate }
        : undefined,
    orderBy: `${DATE} DESC`,
    excludeDeleted: !options.includeDeleted,
  });
  return models.map((m) => m.toJSON());
};

export const updateSplitTransactions = async (
  user: MaskedUser,
  transactions: PartialSplitTransaction[],
): Promise<UpsertResult[]> => {
  if (!transactions.length) return [];
  const results: UpsertResult[] = [];

  for (const tx of transactions) {
    try {
      const row = SplitTransactionModel.fromJSON(tx, user.user_id);
      delete row.split_transaction_id;
      delete row.user_id;

      // Scope the update to the caller's user_id — without this a caller
      // could patch another user's split transaction by id.
      const updated = await splitTransactionsTable.update(
        tx.split_transaction_id,
        row,
        undefined,
        user.user_id,
      );
      results.push(
        updated
          ? successResult(tx.split_transaction_id, 1)
          : noChangeResult(tx.split_transaction_id),
      );
    } catch (error) {
      logger.error("Failed to update split transaction", { splitTransactionId: tx.split_transaction_id }, error);
      results.push(errorResult(tx.split_transaction_id));
    }
  }
  return results;
};

export const deleteSplitTransactions = async (
  user: MaskedUser,
  split_transaction_ids: string[],
  client?: QueryExecutor,
): Promise<{ deleted: number }> => {
  if (!split_transaction_ids.length) return { deleted: 0 };
  const deleted = await splitTransactionsTable.bulkSoftDelete(
    split_transaction_ids,
    { [USER_ID]: user.user_id },
    client,
  );
  return { deleted };
};

export const deleteSplitTransactionsByTransaction = async (
  user: MaskedUser,
  transaction_id: string,
  client?: QueryExecutor,
): Promise<{ deleted: number }> => {
  const txs = await getSplitTransactionsByTransaction(user, transaction_id);
  if (!txs.length) return { deleted: 0 };
  return deleteSplitTransactions(
    user,
    txs.map((t) => t.split_transaction_id),
    client,
  );
};

/**
 * Re-point a pending transaction's live split rows onto the posted
 * transaction that supersedes it (pending→posted transition).
 *
 * Without this, `syncPlaidTransactions` tombstones the pending row's
 * splits in the removal cascade (`deleteTransactions` soft-deletes
 * splits by `transaction_id`, and the per-id helper repeats it) while
 * the label and `rejected_categories` migrate — the user's split
 * silently disappears and the parent's full amount reverts to a single
 * category in every rollup. The caller must run this AFTER the posted
 * row is upserted and BEFORE the removal cascade for the pending id:
 * the posted id arrives in the same batch, so it carries no user
 * splits of its own yet, and re-pointing first keeps the cascade from
 * ever seeing these rows under the pending id.
 *
 * Guard: if the posted id already carries live splits — the posted row
 * was re-served in a later modified batch after splits were created
 * against it — merging the pending side's splits on top would stack
 * two sets under one parent and double-count in rollups. Skip and
 * warn instead; the pending side's splits stay put and the removal
 * cascade handles them as before.
 *
 * Scoped to the caller's `user_id` and to live rows only — a split the
 * user already deleted stays deleted under the pending id. Bumps
 * `updated` so delta/cursor syncs pick the re-pointed rows up.
 * Returns the number of rows re-pointed.
 */
export const repointSplitTransactionsOnPendingPosted = async (
  user: MaskedUser,
  pending_transaction_id: string,
  posted_transaction_id: string,
): Promise<number> => {
  if (pending_transaction_id === posted_transaction_id) return 0;
  // Non-canonical path: the posted row was re-served in a later batch
  // after live splits were created against it. Merging on top would
  // stack two sets under one parent, so skip and warn instead.
  const postedLive = await pool.query(
    `
    SELECT 1 FROM ${SPLIT_TRANSACTIONS}
    WHERE ${USER_ID} = $1
      AND ${TRANSACTION_ID} = $2
      AND (${IS_DELETED} IS NULL OR ${IS_DELETED} = FALSE)
    LIMIT 1
    `,
    [user.user_id, posted_transaction_id],
  );
  if ((postedLive.rowCount ?? 0) > 0) {
    logger.warn("Skipping split re-point: posted transaction already has live splits", {
      pending: pending_transaction_id,
      posted: posted_transaction_id,
    });
    return 0;
  }
  const result = await pool.query(
    `
    UPDATE ${SPLIT_TRANSACTIONS}
    SET ${TRANSACTION_ID} = $3, ${UPDATED} = CURRENT_TIMESTAMP
    WHERE ${USER_ID} = $1
      AND ${TRANSACTION_ID} = $2
      AND (${IS_DELETED} IS NULL OR ${IS_DELETED} = FALSE)
    `,
    [user.user_id, pending_transaction_id, posted_transaction_id],
  );
  return result.rowCount ?? 0;
};

export const createSplitTransaction = async (
  user: MaskedUser,
  input: { transaction_id: string; account_id: string },
): Promise<JSONSplitTransaction> => {
  const row = SplitTransactionModel.fromJSON(
    {
      transaction_id: input.transaction_id,
      account_id: input.account_id,
      amount: 0,
      date: new Date().toISOString().split("T")[0],
      custom_name: "",
    },
    user.user_id,
  );

  const result = await splitTransactionsTable.insert(row, ["*"]);
  if (!result) throw new Error("Failed to create split transaction");
  const model = new SplitTransactionModel(result);
  return model.toJSON();
};
