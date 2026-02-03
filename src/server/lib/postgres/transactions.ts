import {
  JSONTransaction,
  RemovedTransaction,
  JSONInvestmentTransaction,
  RemovedInvestmentTransaction,
  JSONSplitTransaction,
  RemovedSplitTransaction,
  DeepPartial,
} from "common";
import { pool } from "./client";
import { MaskedUser } from "./users";

export type PartialTransaction = { transaction_id: string } & Partial<JSONTransaction>;

/**
 * Updates or inserts transactions documents associated with given user.
 * @param user
 * @param transactions
 * @param upsert
 * @returns A promise to be an array of result objects
 */
export const upsertTransactions = async (
  user: MaskedUser,
  transactions: PartialTransaction[],
  upsert: boolean = true
) => {
  if (!transactions.length) return [];
  const { user_id } = user;
  const results: { update: { _id: string }; status: number }[] = [];
  const updated = new Date().toISOString();

  for (const transaction of transactions) {
    const { transaction_id, label, ...rest } = transaction;

    if (upsert) {
      const result = await pool.query(
        `INSERT INTO transactions (transaction_id, user_id, label, data, updated)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (transaction_id) DO UPDATE SET
           label = COALESCE($3, transactions.label),
           data = transactions.data || $4,
           updated = $5
         WHERE transactions.user_id = $2
         RETURNING transaction_id`,
        [transaction_id, user_id, JSON.stringify(label), JSON.stringify(rest), updated]
      );
      results.push({ update: { _id: transaction_id }, status: result.rowCount ? 200 : 404 });
    } else {
      const result = await pool.query(
        `UPDATE transactions SET
           label = COALESCE($3, label),
           data = data || $4,
           updated = $5
         WHERE transaction_id = $1 AND user_id = $2
         RETURNING transaction_id`,
        [transaction_id, user_id, JSON.stringify(label), JSON.stringify(rest), updated]
      );
      results.push({ update: { _id: transaction_id }, status: result.rowCount ? 200 : 404 });
    }
  }

  return results;
};

export interface SearchTransactionsOptions {
  range?: DateRange;
  query?: DeepPartial<JSONTransaction>;
}

interface DateRange {
  start: Date;
  end: Date;
}

/**
 * Searches for transactions associated with given user.
 * @param user
 * @param options (optional)
 * @returns A promise to have arrays of Transaction objects
 */
export const searchTransactions = async (user: MaskedUser, options?: SearchTransactionsOptions) => {
  const { user_id } = user;
  const { range, query } = options || {};
  const { start, end } = range || {};
  const isValidRange = start && end && start < end;

  // Build query for transactions
  let transactionConditions = ["user_id = $1"];
  let transactionValues: any[] = [user_id];
  let paramIndex = 2;

  if (isValidRange) {
    transactionConditions.push(`updated >= $${paramIndex++}`);
    transactionValues.push(start.toISOString());
    transactionConditions.push(`updated < $${paramIndex++}`);
    transactionValues.push(end.toISOString());
  }

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && key !== "label") {
        transactionConditions.push(`data->>'${key}' = $${paramIndex++}`);
        transactionValues.push(String(value));
      }
    }
  }

  const transactionsResult = await pool.query<{
    transaction_id: string;
    label: any;
    data: any;
  }>(
    `SELECT transaction_id, label, data FROM transactions 
     WHERE ${transactionConditions.join(" AND ")}`,
    transactionValues
  );

  // Build query for investment transactions
  let investmentConditions = ["user_id = $1"];
  let investmentValues: any[] = [user_id];
  paramIndex = 2;

  if (isValidRange) {
    investmentConditions.push(`updated >= $${paramIndex++}`);
    investmentValues.push(start.toISOString());
    investmentConditions.push(`updated < $${paramIndex++}`);
    investmentValues.push(end.toISOString());
  }

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        investmentConditions.push(`data->>'${key}' = $${paramIndex++}`);
        investmentValues.push(String(value));
      }
    }
  }

  const investmentResult = await pool.query<{
    investment_transaction_id: string;
    data: any;
  }>(
    `SELECT investment_transaction_id, data FROM investment_transactions 
     WHERE ${investmentConditions.join(" AND ")}`,
    investmentValues
  );

  const transactions: JSONTransaction[] = transactionsResult.rows.map((row) => ({
    ...row.data,
    transaction_id: row.transaction_id,
    label: row.label || {},
  }));

  const investment_transactions: JSONInvestmentTransaction[] = investmentResult.rows.map((row) => ({
    ...row.data,
    investment_transaction_id: row.investment_transaction_id,
  }));

  return { transactions, investment_transactions };
};

export interface SearchSplitTransactionsOptions {
  range?: DateRange;
  query?: DeepPartial<JSONSplitTransaction>;
}

/**
 * Searches for split transactions associated with given user.
 * @param user
 * @param options (optional)
 * @returns A promise to have arrays of SplitTransaction objects
 */
export const searchSplitTransactions = async (
  user: MaskedUser,
  options?: SearchSplitTransactionsOptions
) => {
  const { user_id } = user;
  const { range, query } = options || {};
  const { start, end } = range || {};
  const isValidRange = start && end && start < end;

  let conditions = ["user_id = $1"];
  let values: any[] = [user_id];
  let paramIndex = 2;

  if (isValidRange) {
    conditions.push(`updated >= $${paramIndex++}`);
    values.push(start.toISOString());
    conditions.push(`updated < $${paramIndex++}`);
    values.push(end.toISOString());
  }

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && key !== "label") {
        if (key === "transaction_id" || key === "account_id") {
          conditions.push(`${key} = $${paramIndex++}`);
        } else {
          conditions.push(`data->>'${key}' = $${paramIndex++}`);
        }
        values.push(String(value));
      }
    }
  }

  const result = await pool.query<{
    split_transaction_id: string;
    transaction_id: string;
    account_id: string;
    amount: number;
    date: string;
    custom_name: string;
    label: any;
  }>(
    `SELECT split_transaction_id, transaction_id, account_id, amount, date, custom_name, label 
     FROM split_transactions 
     WHERE ${conditions.join(" AND ")}`,
    values
  );

  const split_transactions: JSONSplitTransaction[] = result.rows.map((row) => ({
    split_transaction_id: row.split_transaction_id,
    transaction_id: row.transaction_id,
    account_id: row.account_id,
    amount: row.amount,
    date: row.date,
    custom_name: row.custom_name,
    label: row.label || {},
  }));

  return { split_transactions };
};

/**
 * Searches for transactions associated with given user and account id.
 * @param user
 * @param accountIds
 * @param range (optional)
 * @returns A promise to have arrays of Transaction objects
 */
export const searchTransactionsByAccountId = async (
  user: MaskedUser,
  accountIds: string[],
  range?: DateRange
) => {
  if (!Array.isArray(accountIds) || !accountIds.length) {
    return {
      transactions: [],
      investment_transactions: [],
      split_transactions: [],
    };
  }

  const { user_id } = user;
  const { start, end } = range || {};
  const isValidRange = start && end && start < end;

  // Query transactions
  let transactionConditions = ["user_id = $1", "data->>'account_id' = ANY($2)"];
  let transactionValues: any[] = [user_id, accountIds];
  let paramIndex = 3;

  if (isValidRange) {
    transactionConditions.push(`updated >= $${paramIndex++}`);
    transactionValues.push(start.toISOString());
    transactionConditions.push(`updated < $${paramIndex++}`);
    transactionValues.push(end.toISOString());
  }

  const transactionsResult = await pool.query<{
    transaction_id: string;
    label: any;
    data: any;
  }>(
    `SELECT transaction_id, label, data FROM transactions 
     WHERE ${transactionConditions.join(" AND ")}`,
    transactionValues
  );

  // Query investment transactions
  let investmentConditions = ["user_id = $1", "data->>'account_id' = ANY($2)"];
  let investmentValues: any[] = [user_id, accountIds];
  paramIndex = 3;

  if (isValidRange) {
    investmentConditions.push(`updated >= $${paramIndex++}`);
    investmentValues.push(start.toISOString());
    investmentConditions.push(`updated < $${paramIndex++}`);
    investmentValues.push(end.toISOString());
  }

  const investmentResult = await pool.query<{
    investment_transaction_id: string;
    data: any;
  }>(
    `SELECT investment_transaction_id, data FROM investment_transactions 
     WHERE ${investmentConditions.join(" AND ")}`,
    investmentValues
  );

  // Query split transactions
  let splitConditions = ["user_id = $1", "account_id = ANY($2)"];
  let splitValues: any[] = [user_id, accountIds];
  paramIndex = 3;

  if (isValidRange) {
    splitConditions.push(`updated >= $${paramIndex++}`);
    splitValues.push(start.toISOString());
    splitConditions.push(`updated < $${paramIndex++}`);
    splitValues.push(end.toISOString());
  }

  const splitResult = await pool.query<{
    split_transaction_id: string;
    transaction_id: string;
    account_id: string;
    amount: number;
    date: string;
    custom_name: string;
    label: any;
  }>(
    `SELECT split_transaction_id, transaction_id, account_id, amount, date, custom_name, label 
     FROM split_transactions 
     WHERE ${splitConditions.join(" AND ")}`,
    splitValues
  );

  return {
    transactions: transactionsResult.rows.map((row) => ({
      ...row.data,
      transaction_id: row.transaction_id,
      label: row.label || {},
    })) as JSONTransaction[],
    investment_transactions: investmentResult.rows.map((row) => ({
      ...row.data,
      investment_transaction_id: row.investment_transaction_id,
    })) as JSONInvestmentTransaction[],
    split_transactions: splitResult.rows.map((row) => ({
      split_transaction_id: row.split_transaction_id,
      transaction_id: row.transaction_id,
      account_id: row.account_id,
      amount: row.amount,
      date: row.date,
      custom_name: row.custom_name,
      label: row.label || {},
    })) as JSONSplitTransaction[],
  };
};

/**
 * Searches for the oldest transaction date for a user.
 * @param user
 * @returns A promise to be a Date object
 */
export const getOldestTransactionDate = async (user: MaskedUser) => {
  const { user_id } = user;

  const transactionResult = await pool.query(
    `SELECT MIN((data->>'date')::date) as min_date FROM transactions WHERE user_id = $1`,
    [user_id]
  );

  const investmentResult = await pool.query(
    `SELECT MIN((data->>'date')::date) as min_date FROM investment_transactions WHERE user_id = $1`,
    [user_id]
  );

  const transactionDate = transactionResult.rows[0]?.min_date;
  const investmentDate = investmentResult.rows[0]?.min_date;

  if (transactionDate && investmentDate) {
    return new Date(Math.min(new Date(transactionDate).getTime(), new Date(investmentDate).getTime()));
  } else if (transactionDate) {
    return new Date(transactionDate);
  } else if (investmentDate) {
    return new Date(investmentDate);
  } else {
    return new Date();
  }
};

/**
 * Deletes transactions by transaction_id in given transactions data.
 * @param user
 * @param transactions
 * @returns A promise with the delete result
 */
export const deleteTransactions = async (
  user: MaskedUser,
  transactions: (JSONTransaction | RemovedTransaction)[]
) => {
  if (!Array.isArray(transactions) || !transactions.length) return;
  const { user_id } = user;

  const transactionIds = transactions.map((e) => e.transaction_id);

  const result = await pool.query(
    `DELETE FROM transactions WHERE user_id = $1 AND transaction_id = ANY($2)`,
    [user_id, transactionIds]
  );

  return { deleted: result.rowCount };
};

export type PartialInvestmentTransaction = {
  investment_transaction_id: string;
} & Partial<JSONInvestmentTransaction>;

/**
 * Updates or inserts investment transactions with given data.
 * @param user
 * @param investment_transactions
 * @param upsert
 * @returns A promise to be an array of result objects
 */
export const upsertInvestmentTransactions = async (
  user: MaskedUser,
  investment_transactions: PartialInvestmentTransaction[],
  upsert: boolean = true
) => {
  if (!investment_transactions.length) return [];
  const { user_id } = user;
  const results: { update: { _id: string }; status: number }[] = [];
  const updated = new Date().toISOString();

  for (const transaction of investment_transactions) {
    const { investment_transaction_id, ...rest } = transaction;

    if (upsert) {
      const result = await pool.query(
        `INSERT INTO investment_transactions (investment_transaction_id, user_id, data, updated)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (investment_transaction_id) DO UPDATE SET
           data = investment_transactions.data || $3,
           updated = $4
         WHERE investment_transactions.user_id = $2
         RETURNING investment_transaction_id`,
        [investment_transaction_id, user_id, JSON.stringify(rest), updated]
      );
      results.push({ update: { _id: investment_transaction_id }, status: result.rowCount ? 200 : 404 });
    } else {
      const result = await pool.query(
        `UPDATE investment_transactions SET data = data || $3, updated = $4
         WHERE investment_transaction_id = $1 AND user_id = $2
         RETURNING investment_transaction_id`,
        [investment_transaction_id, user_id, JSON.stringify(rest), updated]
      );
      results.push({ update: { _id: investment_transaction_id }, status: result.rowCount ? 200 : 404 });
    }
  }

  return results;
};

/**
 * Deletes investment transactions by id in given data.
 * @param user
 * @param investment_transactions
 * @returns A promise with the delete result
 */
export const deleteInvestmentTransactions = async (
  user: MaskedUser,
  investment_transactions: (JSONInvestmentTransaction | RemovedInvestmentTransaction)[]
) => {
  if (!Array.isArray(investment_transactions) || !investment_transactions.length) return;
  const { user_id } = user;

  const ids = investment_transactions.map((e) => e.investment_transaction_id);

  const result = await pool.query(
    `DELETE FROM investment_transactions WHERE user_id = $1 AND investment_transaction_id = ANY($2)`,
    [user_id, ids]
  );

  return { deleted: result.rowCount };
};

/**
 * Creates a document that represents a split transaction.
 * @param user
 * @param transaction_id parent transaction's id
 * @param account_id
 * @returns A promise with the created split transaction id
 */
export const createSplitTransaction = async (
  user: MaskedUser,
  transaction_id: string,
  account_id: string
) => {
  const { user_id } = user;
  const updated = new Date().toISOString();

  const result = await pool.query(
    `INSERT INTO split_transactions (user_id, transaction_id, account_id, amount, date, custom_name, label, updated)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING split_transaction_id`,
    [user_id, transaction_id, account_id, 0, new Date().toISOString(), "", JSON.stringify({}), updated]
  );

  return { _id: result.rows[0].split_transaction_id };
};

export type PartialSplitTransaction = {
  split_transaction_id: string;
} & Partial<JSONSplitTransaction>;

/**
 * Updates or inserts split transactions documents associated with given user.
 * @param user
 * @param splitTransactions
 * @param upsert
 * @returns A promise to be an array of result objects
 */
export const upsertSplitTransactions = async (
  user: MaskedUser,
  splitTransactions: PartialSplitTransaction[],
  upsert: boolean = true
) => {
  if (!splitTransactions.length) return [];
  const { user_id } = user;
  const results: { update: { _id: string }; status: number }[] = [];
  const updated = new Date().toISOString();

  for (const splitTransaction of splitTransactions) {
    const { split_transaction_id, transaction_id, account_id, amount, date, custom_name, label } = splitTransaction;

    if (upsert) {
      const result = await pool.query(
        `INSERT INTO split_transactions (split_transaction_id, user_id, transaction_id, account_id, amount, date, custom_name, label, updated)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (split_transaction_id) DO UPDATE SET
           transaction_id = COALESCE($3, split_transactions.transaction_id),
           account_id = COALESCE($4, split_transactions.account_id),
           amount = COALESCE($5, split_transactions.amount),
           date = COALESCE($6, split_transactions.date),
           custom_name = COALESCE($7, split_transactions.custom_name),
           label = COALESCE($8, split_transactions.label),
           updated = $9
         WHERE split_transactions.user_id = $2
         RETURNING split_transaction_id`,
        [split_transaction_id, user_id, transaction_id, account_id, amount, date, custom_name, JSON.stringify(label), updated]
      );
      results.push({ update: { _id: split_transaction_id }, status: result.rowCount ? 200 : 404 });
    } else {
      const updates: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (transaction_id !== undefined) {
        updates.push(`transaction_id = $${paramIndex++}`);
        values.push(transaction_id);
      }
      if (account_id !== undefined) {
        updates.push(`account_id = $${paramIndex++}`);
        values.push(account_id);
      }
      if (amount !== undefined) {
        updates.push(`amount = $${paramIndex++}`);
        values.push(amount);
      }
      if (date !== undefined) {
        updates.push(`date = $${paramIndex++}`);
        values.push(date);
      }
      if (custom_name !== undefined) {
        updates.push(`custom_name = $${paramIndex++}`);
        values.push(custom_name);
      }
      if (label !== undefined) {
        updates.push(`label = $${paramIndex++}`);
        values.push(JSON.stringify(label));
      }
      updates.push(`updated = $${paramIndex++}`);
      values.push(updated);

      values.push(split_transaction_id);
      values.push(user_id);

      const result = await pool.query(
        `UPDATE split_transactions SET ${updates.join(", ")}
         WHERE split_transaction_id = $${paramIndex++} AND user_id = $${paramIndex}
         RETURNING split_transaction_id`,
        values
      );
      results.push({ update: { _id: split_transaction_id }, status: result.rowCount ? 200 : 404 });
    }
  }

  return results;
};

/**
 * Deletes split transactions by id in given data.
 * @param user
 * @param split_transactions
 * @returns A promise with the delete result
 */
export const deleteSplitTransactions = async (
  user: MaskedUser,
  split_transactions: (JSONSplitTransaction | RemovedSplitTransaction)[]
) => {
  if (!Array.isArray(split_transactions) || !split_transactions.length) return;
  const { user_id } = user;

  const ids = split_transactions.map((e) => e.split_transaction_id);

  const result = await pool.query(
    `DELETE FROM split_transactions WHERE user_id = $1 AND split_transaction_id = ANY($2)`,
    [user_id, ids]
  );

  return { deleted: result.rowCount };
};

/**
 * Deletes split transactions by id in transactionIds.
 * @param user
 * @param transactionIds
 * @returns A promise with the delete result
 */
export const deleteSplitTransactionsByTransactionId = async (
  user: MaskedUser,
  transactionIds: string[]
) => {
  if (!Array.isArray(transactionIds) || !transactionIds.length) return;
  const { user_id } = user;

  const result = await pool.query(
    `DELETE FROM split_transactions WHERE user_id = $1 AND transaction_id = ANY($2)`,
    [user_id, transactionIds]
  );

  return { deleted: result.rowCount };
};

/**
 * Deletes split transactions by id in given accountIds.
 * @param user
 * @param accountIds
 * @returns A promise with the delete result
 */
export const deleteSplitTransactionsByAccountId = async (
  user: MaskedUser,
  accountIds: string[]
) => {
  if (!Array.isArray(accountIds) || !accountIds.length) return;
  const { user_id } = user;

  const result = await pool.query(
    `DELETE FROM split_transactions WHERE user_id = $1 AND account_id = ANY($2)`,
    [user_id, accountIds]
  );

  return { deleted: result.rowCount };
};
