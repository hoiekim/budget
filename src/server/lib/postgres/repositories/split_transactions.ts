import { JSONSplitTransaction } from "common";
import {
  MaskedUser, SplitTransactionModel, splitTransactionsTable,
  SPLIT_TRANSACTION_ID, TRANSACTION_ID, ACCOUNT_ID, USER_ID,
} from "../models";
import { UpsertResult, successResult, errorResult, noChangeResult } from "../database";

export interface SearchSplitTransactionsOptions {
  transaction_id?: string;
  account_id?: string;
}

export type PartialSplitTransaction = { split_transaction_id: string } & Partial<JSONSplitTransaction>;

export const getSplitTransactions = async (user: MaskedUser): Promise<JSONSplitTransaction[]> => {
  const models = await splitTransactionsTable.query({ [USER_ID]: user.user_id });
  return models.map(m => m.toJSON());
};

export const getSplitTransaction = async (
  user: MaskedUser,
  split_transaction_id: string
): Promise<JSONSplitTransaction | null> => {
  const model = await splitTransactionsTable.queryOne({
    [USER_ID]: user.user_id,
    [SPLIT_TRANSACTION_ID]: split_transaction_id,
  });
  return model?.toJSON() ?? null;
};

export const getSplitTransactionsByTransaction = async (
  user: MaskedUser,
  transaction_id: string
): Promise<JSONSplitTransaction[]> => {
  const models = await splitTransactionsTable.query({
    [USER_ID]: user.user_id,
    [TRANSACTION_ID]: transaction_id,
  });
  return models.map(m => m.toJSON());
};

export const searchSplitTransactions = async (
  user: MaskedUser,
  options: SearchSplitTransactionsOptions = {}
): Promise<JSONSplitTransaction[]> => {
  const filters: Record<string, unknown> = { [USER_ID]: user.user_id };
  if (options.transaction_id) filters[TRANSACTION_ID] = options.transaction_id;
  if (options.account_id) filters[ACCOUNT_ID] = options.account_id;
  
  const models = await splitTransactionsTable.query(filters);
  return models.map(m => m.toJSON());
};

export const upsertSplitTransactions = async (
  user: MaskedUser,
  transactions: JSONSplitTransaction[]
): Promise<UpsertResult[]> => {
  if (!transactions.length) return [];
  const results: UpsertResult[] = [];

  for (const tx of transactions) {
    try {
      const row = SplitTransactionModel.toRow(tx, user.user_id);
      const result = await splitTransactionsTable.upsert(row);
      const id = result ? (result.split_transaction_id as string) : tx.split_transaction_id;
      results.push(successResult(id, 1));
    } catch (error) {
      console.error(`Failed to upsert split transaction ${tx.split_transaction_id}:`, error);
      results.push(errorResult(tx.split_transaction_id || "unknown"));
    }
  }
  return results;
};

export const updateSplitTransactions = async (
  user: MaskedUser,
  transactions: PartialSplitTransaction[]
): Promise<UpsertResult[]> => {
  if (!transactions.length) return [];
  const results: UpsertResult[] = [];

  for (const tx of transactions) {
    try {
      const row = SplitTransactionModel.toRow(tx, user.user_id);
      delete row.split_transaction_id;
      delete row.user_id;
      
      const updated = await splitTransactionsTable.update(tx.split_transaction_id, row);
      results.push(updated ? successResult(tx.split_transaction_id, 1) : noChangeResult(tx.split_transaction_id));
    } catch (error) {
      console.error(`Failed to update split transaction ${tx.split_transaction_id}:`, error);
      results.push(errorResult(tx.split_transaction_id));
    }
  }
  return results;
};

export const deleteSplitTransactions = async (
  user: MaskedUser,
  split_transaction_ids: string[]
): Promise<{ deleted: number }> => {
  if (!split_transaction_ids.length) return { deleted: 0 };
  const deleted = await splitTransactionsTable.bulkSoftDelete(split_transaction_ids, { [USER_ID]: user.user_id });
  return { deleted };
};

export const deleteSplitTransactionsByTransaction = async (
  user: MaskedUser,
  transaction_id: string
): Promise<{ deleted: number }> => {
  const txs = await getSplitTransactionsByTransaction(user, transaction_id);
  if (!txs.length) return { deleted: 0 };
  return deleteSplitTransactions(user, txs.map(t => t.split_transaction_id));
};

export const createSplitTransaction = async (
  user: MaskedUser,
  input: { transaction_id: string; account_id: string }
): Promise<JSONSplitTransaction> => {
  const row = SplitTransactionModel.toRow({
    transaction_id: input.transaction_id,
    account_id: input.account_id,
    amount: 0,
    date: new Date().toISOString().split('T')[0],
    custom_name: '',
  }, user.user_id);
  
  const result = await splitTransactionsTable.insert(row, ['*']);
  if (!result) throw new Error('Failed to create split transaction');
  const model = new SplitTransactionModel(result);
  return model.toJSON();
};
