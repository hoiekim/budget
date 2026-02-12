import { JSONTransaction, JSONInvestmentTransaction } from "common";
import {
  MaskedUser, TransactionModel, InvestmentTransactionModel, transactionsTable, splitTransactionsTable,
  TRANSACTION_ID, ACCOUNT_ID, USER_ID, DATE,
} from "../models";
import { pool } from "../client";
import { buildSelectWithFilters, UpsertResult, successResult, errorResult, noChangeResult } from "../database";

export interface SearchTransactionsOptions {
  account_id?: string;
  account_ids?: string[];
  startDate?: string;
  endDate?: string;
  pending?: boolean;
  limit?: number;
  offset?: number;
}

export type PartialTransaction = { transaction_id: string } & Partial<JSONTransaction>;

export const getTransactions = async (
  user: MaskedUser,
  options: SearchTransactionsOptions = {}
): Promise<JSONTransaction[]> => {
  const { sql, values } = buildSelectWithFilters("transactions", "*", {
    user_id: user.user_id,
    filters: { [ACCOUNT_ID]: options.account_id, pending: options.pending },
    dateRange: options.startDate || options.endDate
      ? { column: DATE, start: options.startDate, end: options.endDate }
      : undefined,
    orderBy: `${DATE} DESC`,
    limit: options.limit,
    offset: options.offset,
  });
  const result = await pool.query<Record<string, unknown>>(sql, values);
  return result.rows.map(row => new TransactionModel(row).toJSON());
};

export const getTransaction = async (user: MaskedUser, transaction_id: string): Promise<JSONTransaction | null> => {
  const model = await transactionsTable.queryOne({ [USER_ID]: user.user_id, [TRANSACTION_ID]: transaction_id });
  return model?.toJSON() ?? null;
};

export const searchTransactions = async (
  user: MaskedUser,
  options: SearchTransactionsOptions = {}
): Promise<{ transactions: JSONTransaction[]; investment_transactions: JSONInvestmentTransaction[] }> => {
  const transactions = await getTransactions(user, options);
  
  // For now, get investment transactions with the same filters
  const { sql, values } = buildSelectWithFilters("investment_transactions", "*", {
    user_id: user.user_id,
    filters: { [ACCOUNT_ID]: options.account_id },
    dateRange: options.startDate || options.endDate
      ? { column: DATE, start: options.startDate, end: options.endDate }
      : undefined,
    orderBy: `${DATE} DESC`,
    limit: options.limit,
    offset: options.offset,
  });
  const result = await pool.query<Record<string, unknown>>(sql, values);
  const investment_transactions = result.rows.map(row => new InvestmentTransactionModel(row).toJSON());
  
  return { transactions, investment_transactions };
};

export const searchTransactionsById = async (user: MaskedUser, transaction_ids: string[]): Promise<JSONTransaction[]> => {
  if (!transaction_ids.length) return [];
  const models = await transactionsTable.queryByIds(transaction_ids, { [USER_ID]: user.user_id });
  return models.map(m => m.toJSON());
};

export const upsertTransactions = async (user: MaskedUser, transactions: JSONTransaction[]): Promise<UpsertResult[]> => {
  if (!transactions.length) return [];
  const results: UpsertResult[] = [];

  for (const tx of transactions) {
    try {
      const row = TransactionModel.toRow(tx, user.user_id);
      await transactionsTable.upsert(row);
      results.push(successResult(tx.transaction_id, 1));
    } catch (error) {
      console.error(`Failed to upsert transaction ${tx.transaction_id}:`, error);
      results.push(errorResult(tx.transaction_id));
    }
  }
  return results;
};

export const updateTransactions = async (user: MaskedUser, transactions: PartialTransaction[]): Promise<UpsertResult[]> => {
  if (!transactions.length) return [];
  const results: UpsertResult[] = [];

  for (const tx of transactions) {
    try {
      const row = TransactionModel.toRow(tx, user.user_id);
      delete row.transaction_id;
      delete row.user_id;
      
      const updated = await transactionsTable.update(tx.transaction_id, row);
      results.push(updated ? successResult(tx.transaction_id, 1) : noChangeResult(tx.transaction_id));
    } catch (error) {
      console.error(`Failed to update transaction ${tx.transaction_id}:`, error);
      results.push(errorResult(tx.transaction_id));
    }
  }
  return results;
};

export const deleteTransactions = async (user: MaskedUser, transaction_ids: string[]): Promise<{ deleted: number }> => {
  if (!transaction_ids.length) return { deleted: 0 };

  for (const tx_id of transaction_ids) {
    await splitTransactionsTable.bulkSoftDeleteByColumn(TRANSACTION_ID, tx_id, user.user_id);
  }

  const deleted = await transactionsTable.bulkSoftDelete(transaction_ids, { [USER_ID]: user.user_id });
  return { deleted };
};

export const deleteTransactionsByAccount = async (user: MaskedUser, account_id: string): Promise<{ deleted: number }> => {
  const { transactions } = await searchTransactions(user, { account_id });
  if (!transactions.length) return { deleted: 0 };
  return deleteTransactions(user, transactions.map(t => t.transaction_id));
};

export const searchTransactionsByAccountId = async (
  user: MaskedUser,
  account_ids: string[],
  range?: { start?: Date; end?: Date }
): Promise<{ transactions: JSONTransaction[]; investment_transactions: JSONInvestmentTransaction[] }> => {
  if (!account_ids.length) return { transactions: [], investment_transactions: [] };
  
  const placeholders = account_ids.map((_, i) => `$${i + 2}`).join(", ");
  const values: (string | Date)[] = [user.user_id, ...account_ids];
  
  let txSql = `SELECT * FROM transactions WHERE ${ACCOUNT_ID} IN (${placeholders}) AND ${USER_ID} = $1 AND (is_deleted IS NULL OR is_deleted = FALSE)`;
  let invSql = `SELECT * FROM investment_transactions WHERE ${ACCOUNT_ID} IN (${placeholders}) AND ${USER_ID} = $1 AND (is_deleted IS NULL OR is_deleted = FALSE)`;
  
  if (range?.start) {
    const idx = values.length + 1;
    values.push(range.start);
    txSql += ` AND ${DATE} >= $${idx}`;
    invSql += ` AND ${DATE} >= $${idx}`;
  }
  if (range?.end) {
    const idx = values.length + 1;
    values.push(range.end);
    txSql += ` AND ${DATE} <= $${idx}`;
    invSql += ` AND ${DATE} <= $${idx}`;
  }
  txSql += ` ORDER BY ${DATE} DESC`;
  invSql += ` ORDER BY ${DATE} DESC`;
  
  const [txResult, invResult] = await Promise.all([
    pool.query<Record<string, unknown>>(txSql, values),
    pool.query<Record<string, unknown>>(invSql, values),
  ]);
  
  return {
    transactions: txResult.rows.map(row => new TransactionModel(row).toJSON()),
    investment_transactions: invResult.rows.map(row => new InvestmentTransactionModel(row).toJSON()),
  };
};

export const getOldestTransactionDate = async (user: MaskedUser, account_id?: string): Promise<string | null> => {
  const filters: Record<string, unknown> = { [USER_ID]: user.user_id };
  if (account_id) filters[ACCOUNT_ID] = account_id;
  
  const result = await pool.query<{ oldest_date: string }>(
    `SELECT MIN(${DATE}) as oldest_date FROM transactions WHERE ${USER_ID} = $1 ${account_id ? `AND ${ACCOUNT_ID} = $2` : ''} AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    account_id ? [user.user_id, account_id] : [user.user_id]
  );
  return result.rows[0]?.oldest_date ?? null;
};
