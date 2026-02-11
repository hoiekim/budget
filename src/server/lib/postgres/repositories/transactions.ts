/**
 * Transaction repository - CRUD operations for transactions, investment transactions, split transactions.
 */

import { JSONTransaction, JSONInvestmentTransaction, JSONSplitTransaction } from "common";
import { pool } from "../client";
import {
  MaskedUser,
  TransactionModel,
  TransactionRow,
  InvestmentTransactionModel,
  InvestmentTransactionRow,
  SplitTransactionModel,
  SplitTransactionRow,
  TRANSACTIONS,
  INVESTMENT_TRANSACTIONS,
  SPLIT_TRANSACTIONS,
  TRANSACTION_ID,
  INVESTMENT_TRANSACTION_ID,
  SPLIT_TRANSACTION_ID,
  ACCOUNT_ID,
  USER_ID,
  DATE,
} from "../models";
import {
  buildUpdate,
  buildSelectWithFilters,
  selectWithFilters,
  UpsertResult,
  successResult,
  errorResult,
  noChangeResult,
} from "../database";

// =============================================
// Types
// =============================================

export interface SearchTransactionsOptions {
  account_id?: string;
  account_ids?: string[];
  startDate?: string;
  endDate?: string;
  pending?: boolean;
  limit?: number;
  offset?: number;
}

export interface SearchSplitTransactionsOptions {
  transaction_id?: string;
  account_id?: string;
}

export type PartialTransaction = { transaction_id: string } & Partial<JSONTransaction>;
export type PartialSplitTransaction = { split_transaction_id: string } & Partial<JSONSplitTransaction>;

// =============================================
// Query Helpers
// =============================================

const rowToTransaction = (row: TransactionRow): JSONTransaction =>
  new TransactionModel(row).toJSON();
const rowToInvestmentTransaction = (row: InvestmentTransactionRow): JSONInvestmentTransaction =>
  new InvestmentTransactionModel(row).toJSON();
const rowToSplitTransaction = (row: SplitTransactionRow): JSONSplitTransaction =>
  new SplitTransactionModel(row).toJSON();

// =============================================
// Transaction Repository Functions
// =============================================

/**
 * Gets transactions for a user with optional filters.
 */
export const getTransactions = async (
  user: MaskedUser,
  options: {
    account_id?: string;
    startDate?: string;
    endDate?: string;
    pending?: boolean;
    limit?: number;
    offset?: number;
  } = {}
): Promise<JSONTransaction[]> => {
  const { sql, values } = buildSelectWithFilters(TRANSACTIONS, "*", {
    user_id: user.user_id,
    filters: {
      [ACCOUNT_ID]: options.account_id,
      pending: options.pending,
    },
    dateRange: options.startDate || options.endDate
      ? { column: DATE, start: options.startDate, end: options.endDate }
      : undefined,
    orderBy: `${DATE} DESC`,
    limit: options.limit,
    offset: options.offset,
  });

  const result = await pool.query<TransactionRow>(sql, values);
  return result.rows.map(rowToTransaction);
};

/**
 * Gets a single transaction by ID.
 */
export const getTransaction = async (
  user: MaskedUser,
  transaction_id: string
): Promise<JSONTransaction | null> => {
  const rows = await selectWithFilters<TransactionRow>(pool, TRANSACTIONS, "*", {
    user_id: user.user_id,
    primaryKey: { column: TRANSACTION_ID, value: transaction_id },
  });
  return rows.length > 0 ? rowToTransaction(rows[0]) : null;
};

/**
 * Gets the oldest transaction date for a user.
 */
export const getOldestTransactionDate = async (
  user: MaskedUser
): Promise<string | null> => {
  const result = await pool.query<{ oldest_date: string }>(
    `SELECT MIN(${DATE}) as oldest_date FROM ${TRANSACTIONS}
     WHERE ${USER_ID} = $1
     AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [user.user_id]
  );
  return result.rows[0]?.oldest_date || null;
};

/**
 * Upserts transactions for a user.
 */
export const upsertTransactions = async (
  user: MaskedUser,
  transactions: JSONTransaction[]
): Promise<UpsertResult[]> => {
  if (!transactions.length) return [];
  const results: UpsertResult[] = [];

  for (const tx of transactions) {
    const row = TransactionModel.fromJSON(tx, user.user_id);

    try {
      const columns = Object.keys(row);
      const values = Object.values(row);
      const placeholders = values.map((_, i) => `$${i + 1}`);

      const updateClauses = columns
        .filter((col) => col !== TRANSACTION_ID && col !== USER_ID)
        .map((col) => `${col} = EXCLUDED.${col}`);
      updateClauses.push("updated = CURRENT_TIMESTAMP");

      const query = `
        INSERT INTO ${TRANSACTIONS} (${columns.join(", ")}, updated)
        VALUES (${placeholders.join(", ")}, CURRENT_TIMESTAMP)
        ON CONFLICT (${TRANSACTION_ID}) DO UPDATE SET
          ${updateClauses.join(", ")}
        WHERE ${TRANSACTIONS}.${USER_ID} = $${columns.indexOf(USER_ID) + 1}
        RETURNING ${TRANSACTION_ID}
      `;

      const result = await pool.query(query, values);
      results.push(successResult(tx.transaction_id, result.rowCount));
    } catch (error) {
      console.error(`Failed to upsert transaction ${tx.transaction_id}:`, error);
      results.push(errorResult(tx.transaction_id));
    }
  }

  return results;
};

/**
 * Updates transactions for a user.
 */
export const updateTransactions = async (
  user: MaskedUser,
  transactions: PartialTransaction[]
): Promise<UpsertResult[]> => {
  if (!transactions.length) return [];
  const results: UpsertResult[] = [];

  for (const tx of transactions) {
    const row = TransactionModel.fromJSON(tx, user.user_id);

    try {
      const updateData = { ...row };
      delete updateData.transaction_id;
      delete updateData.user_id;

      const query = buildUpdate(
        TRANSACTIONS,
        TRANSACTION_ID,
        tx.transaction_id,
        updateData as Record<string, unknown>,
        {
          additionalWhere: { column: USER_ID, value: user.user_id },
          returning: [TRANSACTION_ID],
        }
      );

      if (query) {
        const result = await pool.query(query.sql, query.values);
        results.push(successResult(tx.transaction_id, result.rowCount));
      } else {
        results.push(noChangeResult(tx.transaction_id));
      }
    } catch (error) {
      console.error(`Failed to update transaction ${tx.transaction_id}:`, error);
      results.push(errorResult(tx.transaction_id));
    }
  }

  return results;
};

/**
 * Deletes transactions.
 */
export const deleteTransactions = async (
  user: MaskedUser,
  transaction_ids: string[]
): Promise<{ deleted: number }> => {
  if (!transaction_ids.length) return { deleted: 0 };

  const placeholders = transaction_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `UPDATE ${TRANSACTIONS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE ${TRANSACTION_ID} IN (${placeholders}) AND ${USER_ID} = $1
     RETURNING ${TRANSACTION_ID}`,
    [user.user_id, ...transaction_ids]
  );

  return { deleted: result.rowCount || 0 };
};

/**
 * Searches transactions and investment transactions by account IDs.
 */
export const searchTransactionsByAccountId = async (
  user: MaskedUser,
  account_ids: string[],
  range?: { start: Date; end: Date }
): Promise<{
  transactions: JSONTransaction[];
  investment_transactions: JSONInvestmentTransaction[];
}> => {
  if (!account_ids.length) return { transactions: [], investment_transactions: [] };

  const placeholders = account_ids.map((_, i) => `$${i + 2}`).join(", ");
  const baseConditions = [
    `${USER_ID} = $1`,
    `${ACCOUNT_ID} IN (${placeholders})`,
    "(is_deleted IS NULL OR is_deleted = FALSE)",
  ];
  const values: string[] = [user.user_id, ...account_ids];
  let paramIndex = account_ids.length + 2;

  const rangeConditions: string[] = [];
  if (range) {
    rangeConditions.push(`${DATE} >= $${paramIndex++}`);
    values.push(range.start.toISOString().split("T")[0]);

    rangeConditions.push(`${DATE} <= $${paramIndex}`);
    values.push(range.end.toISOString().split("T")[0]);
  }

  const allConditions = [...baseConditions, ...rangeConditions];

  const [txResult, invTxResult] = await Promise.all([
    pool.query<TransactionRow>(
      `SELECT * FROM ${TRANSACTIONS} WHERE ${allConditions.join(" AND ")} ORDER BY ${DATE} DESC`,
      values
    ),
    pool.query<InvestmentTransactionRow>(
      `SELECT * FROM ${INVESTMENT_TRANSACTIONS} WHERE ${allConditions.join(" AND ")} ORDER BY ${DATE} DESC`,
      values
    ),
  ]);

  return {
    transactions: txResult.rows.map(rowToTransaction),
    investment_transactions: invTxResult.rows.map(rowToInvestmentTransaction),
  };
};

/**
 * Searches transactions with flexible options.
 */
export const searchTransactions = async (
  user: MaskedUser,
  options: SearchTransactionsOptions = {}
): Promise<{
  transactions: JSONTransaction[];
  investment_transactions: JSONInvestmentTransaction[];
}> => {
  const searchOptions = {
    user_id: user.user_id,
    filters: {
      [ACCOUNT_ID]: options.account_id,
      pending: options.pending,
    },
    inFilters: options.account_ids?.length
      ? { [ACCOUNT_ID]: options.account_ids }
      : undefined,
    dateRange: options.startDate || options.endDate
      ? { column: DATE, start: options.startDate, end: options.endDate }
      : undefined,
    orderBy: `${DATE} DESC`,
    limit: options.limit,
    offset: options.offset,
  };

  const txQuery = buildSelectWithFilters(TRANSACTIONS, "*", searchOptions);
  const invTxQuery = buildSelectWithFilters(INVESTMENT_TRANSACTIONS, "*", searchOptions);

  const [txResult, invTxResult] = await Promise.all([
    pool.query<TransactionRow>(txQuery.sql, txQuery.values),
    pool.query<InvestmentTransactionRow>(invTxQuery.sql, invTxQuery.values),
  ]);

  return {
    transactions: txResult.rows.map(rowToTransaction),
    investment_transactions: invTxResult.rows.map(rowToInvestmentTransaction),
  };
};

// =============================================
// Investment Transaction Repository Functions
// =============================================

/**
 * Gets investment transactions for a user.
 */
export const getInvestmentTransactions = async (
  user: MaskedUser,
  options: { account_id?: string; startDate?: string; endDate?: string } = {}
): Promise<JSONInvestmentTransaction[]> => {
  const { sql, values } = buildSelectWithFilters(INVESTMENT_TRANSACTIONS, "*", {
    user_id: user.user_id,
    filters: { [ACCOUNT_ID]: options.account_id },
    dateRange: options.startDate || options.endDate
      ? { column: DATE, start: options.startDate, end: options.endDate }
      : undefined,
    orderBy: `${DATE} DESC`,
  });

  const result = await pool.query<InvestmentTransactionRow>(sql, values);
  return result.rows.map(rowToInvestmentTransaction);
};

/**
 * Upserts investment transactions.
 */
export const upsertInvestmentTransactions = async (
  user: MaskedUser,
  transactions: (Partial<JSONInvestmentTransaction> & { investment_transaction_id: string })[]
): Promise<UpsertResult[]> => {
  if (!transactions.length) return [];
  const results: UpsertResult[] = [];

  for (const tx of transactions) {
    const row = InvestmentTransactionModel.fromJSON(tx, user.user_id);

    try {
      const columns = Object.keys(row);
      const values = Object.values(row);
      const placeholders = values.map((_, i) => `$${i + 1}`);

      const updateClauses = columns
        .filter((col) => col !== INVESTMENT_TRANSACTION_ID && col !== USER_ID)
        .map((col) => `${col} = EXCLUDED.${col}`);
      updateClauses.push("updated = CURRENT_TIMESTAMP");

      const query = `
        INSERT INTO ${INVESTMENT_TRANSACTIONS} (${columns.join(", ")}, updated)
        VALUES (${placeholders.join(", ")}, CURRENT_TIMESTAMP)
        ON CONFLICT (${INVESTMENT_TRANSACTION_ID}) DO UPDATE SET
          ${updateClauses.join(", ")}
        RETURNING ${INVESTMENT_TRANSACTION_ID}
      `;

      const result = await pool.query(query, values);
      results.push(successResult(tx.investment_transaction_id, result.rowCount));
    } catch (error) {
      console.error("Failed to upsert investment transaction:", error);
      results.push(errorResult(tx.investment_transaction_id));
    }
  }

  return results;
};

/**
 * Updates investment transactions.
 */
export const updateInvestmentTransactions = async (
  user: MaskedUser,
  transactions: (Partial<JSONInvestmentTransaction> & { investment_transaction_id: string })[]
): Promise<UpsertResult[]> => {
  if (!transactions.length) return [];
  const results: UpsertResult[] = [];

  for (const tx of transactions) {
    const row = InvestmentTransactionModel.fromJSON(tx, user.user_id);

    try {
      const updateData = { ...row };
      delete updateData.investment_transaction_id;
      delete updateData.user_id;

      const query = buildUpdate(
        INVESTMENT_TRANSACTIONS,
        INVESTMENT_TRANSACTION_ID,
        tx.investment_transaction_id,
        updateData as Record<string, unknown>,
        {
          additionalWhere: { column: USER_ID, value: user.user_id },
          returning: [INVESTMENT_TRANSACTION_ID],
        }
      );

      if (query) {
        const result = await pool.query(query.sql, query.values);
        results.push(successResult(tx.investment_transaction_id, result.rowCount));
      } else {
        results.push(noChangeResult(tx.investment_transaction_id));
      }
    } catch (error) {
      console.error("Failed to update investment transaction:", error);
      results.push(errorResult(tx.investment_transaction_id));
    }
  }

  return results;
};

/**
 * Deletes investment transactions.
 */
export const deleteInvestmentTransactions = async (
  user: MaskedUser,
  investment_transaction_ids: string[]
): Promise<{ deleted: number }> => {
  if (!investment_transaction_ids.length) return { deleted: 0 };

  const placeholders = investment_transaction_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `UPDATE ${INVESTMENT_TRANSACTIONS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE ${INVESTMENT_TRANSACTION_ID} IN (${placeholders}) AND ${USER_ID} = $1
     RETURNING ${INVESTMENT_TRANSACTION_ID}`,
    [user.user_id, ...investment_transaction_ids]
  );

  return { deleted: result.rowCount || 0 };
};

// =============================================
// Split Transaction Repository Functions
// =============================================

/**
 * Gets split transactions for a user.
 */
export const getSplitTransactions = async (
  user: MaskedUser,
  transaction_id?: string
): Promise<JSONSplitTransaction[]> => {
  if (transaction_id) {
    const result = await pool.query<SplitTransactionRow>(
      `SELECT * FROM ${SPLIT_TRANSACTIONS}
       WHERE ${TRANSACTION_ID} = $1 AND ${USER_ID} = $2
       AND (is_deleted IS NULL OR is_deleted = FALSE)`,
      [transaction_id, user.user_id]
    );
    return result.rows.map(rowToSplitTransaction);
  }

  const result = await pool.query<SplitTransactionRow>(
    `SELECT * FROM ${SPLIT_TRANSACTIONS}
     WHERE ${USER_ID} = $1
     AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [user.user_id]
  );
  return result.rows.map(rowToSplitTransaction);
};

/**
 * Searches split transactions.
 */
export const searchSplitTransactions = async (
  user: MaskedUser,
  options: SearchSplitTransactionsOptions = {}
): Promise<JSONSplitTransaction[]> => {
  const { sql, values } = buildSelectWithFilters(SPLIT_TRANSACTIONS, "*", {
    user_id: user.user_id,
    filters: {
      [TRANSACTION_ID]: options.transaction_id,
      [ACCOUNT_ID]: options.account_id,
    },
  });

  const result = await pool.query<SplitTransactionRow>(sql, values);
  return result.rows.map(rowToSplitTransaction);
};

/**
 * Creates a new split transaction.
 */
export const createSplitTransaction = async (
  user: MaskedUser,
  data: Partial<JSONSplitTransaction>
): Promise<JSONSplitTransaction | null> => {
  try {
    const result = await pool.query<SplitTransactionRow>(
      `INSERT INTO ${SPLIT_TRANSACTIONS} (
        ${USER_ID}, ${TRANSACTION_ID}, ${ACCOUNT_ID}, amount, ${DATE}, custom_name,
        label_budget_id, label_category_id, label_memo, updated
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
      RETURNING *`,
      [
        user.user_id,
        data.transaction_id,
        data.account_id,
        data.amount || 0,
        data.date,
        data.custom_name || "",
        data.label?.budget_id,
        data.label?.category_id,
        data.label?.memo,
      ]
    );

    return result.rows.length > 0 ? rowToSplitTransaction(result.rows[0]) : null;
  } catch (error) {
    console.error("Failed to create split transaction:", error);
    return null;
  }
};

/**
 * Updates split transactions.
 */
export const updateSplitTransactions = async (
  user: MaskedUser,
  transactions: PartialSplitTransaction[]
): Promise<UpsertResult[]> => {
  if (!transactions.length) return [];
  const results: UpsertResult[] = [];

  for (const tx of transactions) {
    const row = SplitTransactionModel.fromJSON(tx, user.user_id);

    try {
      const updateData = { ...row };
      delete updateData.split_transaction_id;
      delete updateData.user_id;

      const query = buildUpdate(
        SPLIT_TRANSACTIONS,
        SPLIT_TRANSACTION_ID,
        tx.split_transaction_id,
        updateData as Record<string, unknown>,
        {
          additionalWhere: { column: USER_ID, value: user.user_id },
          returning: [SPLIT_TRANSACTION_ID],
        }
      );

      if (query) {
        const result = await pool.query(query.sql, query.values);
        results.push(successResult(tx.split_transaction_id, result.rowCount));
      } else {
        results.push(noChangeResult(tx.split_transaction_id));
      }
    } catch (error) {
      console.error("Failed to update split transaction:", error);
      results.push(errorResult(tx.split_transaction_id));
    }
  }

  return results;
};

/**
 * Deletes split transactions.
 */
export const deleteSplitTransactions = async (
  user: MaskedUser,
  split_transaction_ids: string[]
): Promise<{ deleted: number }> => {
  if (!split_transaction_ids.length) return { deleted: 0 };

  const placeholders = split_transaction_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `UPDATE ${SPLIT_TRANSACTIONS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE ${SPLIT_TRANSACTION_ID} IN (${placeholders}) AND ${USER_ID} = $1
     RETURNING ${SPLIT_TRANSACTION_ID}`,
    [user.user_id, ...split_transaction_ids]
  );

  return { deleted: result.rowCount || 0 };
};

/**
 * Deletes split transactions by transaction ID.
 */
export const deleteSplitTransactionsByTransactionId = async (
  user: MaskedUser,
  transaction_id: string
): Promise<{ deleted: number }> => {
  const result = await pool.query(
    `UPDATE ${SPLIT_TRANSACTIONS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE ${TRANSACTION_ID} = $1 AND ${USER_ID} = $2
     RETURNING ${SPLIT_TRANSACTION_ID}`,
    [transaction_id, user.user_id]
  );

  return { deleted: result.rowCount || 0 };
};
