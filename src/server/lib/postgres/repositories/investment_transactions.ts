import { JSONInvestmentTransaction } from "common";
import {
  MaskedUser,
  InvestmentTransactionModel,
  investmentTransactionsTable,
  INVESTMENT_TRANSACTION_ID,
  ACCOUNT_ID,
  USER_ID,
  DATE,
} from "../models";
import { pool } from "../client";
import {
  buildSelectWithFilters,
  UpsertResult,
  successResult,
  errorResult,
  noChangeResult,
} from "../database";

export interface SearchInvestmentTransactionsOptions {
  account_id?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}

export type PartialInvestmentTransaction = {
  investment_transaction_id: string;
} & Partial<JSONInvestmentTransaction>;

export const getInvestmentTransactions = async (
  user: MaskedUser,
  options: SearchInvestmentTransactionsOptions = {},
): Promise<JSONInvestmentTransaction[]> => {
  const { sql, values } = buildSelectWithFilters("investment_transactions", "*", {
    user_id: user.user_id,
    filters: { [ACCOUNT_ID]: options.account_id },
    dateRange:
      options.startDate || options.endDate
        ? { column: DATE, start: options.startDate, end: options.endDate }
        : undefined,
    orderBy: `${DATE} DESC`,
    limit: options.limit,
    offset: options.offset,
  });
  const result = await pool.query<Record<string, unknown>>(sql, values);
  return result.rows.map((row) => new InvestmentTransactionModel(row).toJSON());
};

export const getInvestmentTransaction = async (
  user: MaskedUser,
  investment_transaction_id: string,
): Promise<JSONInvestmentTransaction | null> => {
  const model = await investmentTransactionsTable.queryOne({
    [USER_ID]: user.user_id,
    [INVESTMENT_TRANSACTION_ID]: investment_transaction_id,
  });
  return model?.toJSON() ?? null;
};

export const searchInvestmentTransactions = async (
  user: MaskedUser,
  options: SearchInvestmentTransactionsOptions = {},
): Promise<JSONInvestmentTransaction[]> => {
  return getInvestmentTransactions(user, options);
};

export const upsertInvestmentTransactions = async (
  user: MaskedUser,
  transactions: JSONInvestmentTransaction[],
): Promise<UpsertResult[]> => {
  if (!transactions.length) return [];
  const results: UpsertResult[] = [];

  for (const tx of transactions) {
    try {
      const row = InvestmentTransactionModel.toRow(tx, user.user_id);
      await investmentTransactionsTable.upsert(row);
      results.push(successResult(tx.investment_transaction_id, 1));
    } catch (error) {
      console.error(
        `Failed to upsert investment transaction ${tx.investment_transaction_id}:`,
        error,
      );
      results.push(errorResult(tx.investment_transaction_id));
    }
  }
  return results;
};

export const updateInvestmentTransactions = async (
  user: MaskedUser,
  transactions: PartialInvestmentTransaction[],
): Promise<UpsertResult[]> => {
  if (!transactions.length) return [];
  const results: UpsertResult[] = [];

  for (const tx of transactions) {
    try {
      const row = InvestmentTransactionModel.toRow(tx, user.user_id);
      delete row.investment_transaction_id;
      delete row.user_id;

      const updated = await investmentTransactionsTable.update(tx.investment_transaction_id, row);
      results.push(
        updated
          ? successResult(tx.investment_transaction_id, 1)
          : noChangeResult(tx.investment_transaction_id),
      );
    } catch (error) {
      console.error(
        `Failed to update investment transaction ${tx.investment_transaction_id}:`,
        error,
      );
      results.push(errorResult(tx.investment_transaction_id));
    }
  }
  return results;
};

export const deleteInvestmentTransactions = async (
  user: MaskedUser,
  transaction_ids: string[],
): Promise<{ deleted: number }> => {
  if (!transaction_ids.length) return { deleted: 0 };
  const deleted = await investmentTransactionsTable.bulkSoftDelete(transaction_ids, {
    [USER_ID]: user.user_id,
  });
  return { deleted };
};

export const deleteInvestmentTransactionsByAccount = async (
  user: MaskedUser,
  account_id: string,
): Promise<{ deleted: number }> => {
  const txs = await searchInvestmentTransactions(user, { account_id });
  if (!txs.length) return { deleted: 0 };
  return deleteInvestmentTransactions(
    user,
    txs.map((t) => t.investment_transaction_id),
  );
};
