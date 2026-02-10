import {
  JSONTransaction,
  JSONInvestmentTransaction,
  JSONSplitTransaction,
  isUndefined,
} from "common";
import { pool } from "./client";
import { MaskedUser } from "./users";
import { buildUpdateQuery } from "./utils";
import {
  InvestmentTransactionSubtype,
  InvestmentTransactionType,
  TransactionPaymentChannelEnum,
} from "plaid";

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

// Database row interfaces
interface TransactionRow {
  transaction_id: string;
  user_id: string;
  account_id: string;
  name?: string | null;
  merchant_name?: string | null;
  amount?: string | number | null;
  iso_currency_code?: string | null;
  date: string;
  pending?: boolean | null;
  pending_transaction_id?: string | null;
  payment_channel?: string | null;
  location_country?: string | null;
  location_region?: string | null;
  location_city?: string | null;
  label_budget_id?: string | null;
  label_category_id?: string | null;
  label_memo?: string | null;
  raw?: string | null;
  updated?: Date | null;
  is_deleted?: boolean | null;
}

interface InvestmentTransactionRow {
  investment_transaction_id: string;
  user_id: string;
  account_id: string;
  security_id?: string | null;
  date: string;
  name?: string | null;
  amount?: string | number | null;
  quantity?: string | number | null;
  price?: string | number | null;
  iso_currency_code?: string | null;
  type?: string | null;
  subtype?: string | null;
  label_budget_id?: string | null;
  label_category_id?: string | null;
  label_memo?: string | null;
  raw?: string | null;
  updated?: Date | null;
  is_deleted?: boolean | null;
}

interface SplitTransactionRow {
  split_transaction_id: string;
  user_id: string;
  transaction_id: string;
  account_id: string;
  amount?: string | number | null;
  date?: string | null;
  custom_name?: string | null;
  label_budget_id?: string | null;
  label_category_id?: string | null;
  label_memo?: string | null;
  updated?: Date | null;
  is_deleted?: boolean | null;
}

/**
 * Converts a transaction object to flat Postgres columns + raw JSONB.
 * Only extracts indexed/queried columns; stores the full provider object in raw.
 */
function transactionToRow(tx: PartialTransaction): Partial<TransactionRow> {
  const row: Partial<TransactionRow> = {};

  if (!isUndefined(tx.transaction_id)) row.transaction_id = tx.transaction_id;
  if (!isUndefined(tx.account_id)) row.account_id = tx.account_id;
  if (!isUndefined(tx.name)) row.name = tx.name;
  if (!isUndefined(tx.merchant_name)) row.merchant_name = tx.merchant_name;
  if (!isUndefined(tx.amount)) row.amount = tx.amount;
  if (!isUndefined(tx.iso_currency_code)) row.iso_currency_code = tx.iso_currency_code;
  if (!isUndefined(tx.date)) row.date = tx.date;
  if (!isUndefined(tx.pending)) row.pending = tx.pending;
  if (!isUndefined(tx.pending_transaction_id))
    row.pending_transaction_id = tx.pending_transaction_id;
  if (!isUndefined(tx.payment_channel)) row.payment_channel = tx.payment_channel;
  if (!isUndefined(tx.location)) {
    if (!isUndefined(tx.location.country)) row.location_country = tx.location.country;
    if (!isUndefined(tx.location.region)) row.location_region = tx.location.region;
    if (!isUndefined(tx.location.city)) row.location_city = tx.location.city;
  }

  // Flatten label (user-edited)
  if (!isUndefined(tx.label)) {
    if (!isUndefined(tx.label.budget_id)) row.label_budget_id = tx.label.budget_id;
    if (!isUndefined(tx.label.category_id)) row.label_category_id = tx.label.category_id;
    if (!isUndefined(tx.label.memo)) row.label_memo = tx.label.memo;
  }

  // Store full provider object in raw (excluding label which is user-edited)
  const { label, ...providerData } = tx;
  row.raw = JSON.stringify(providerData);

  return row;
}

/**
 * Converts a Postgres row to transaction object.
 */
function rowToTransaction(row: TransactionRow): JSONTransaction {
  return {
    transaction_id: row.transaction_id,
    account_id: row.account_id,
    name: row.name || "Unknown",
    merchant_name: row.merchant_name,
    amount: row.amount ? Number(row.amount) : 0,
    iso_currency_code: row.iso_currency_code || null,
    date: row.date || new Date().toISOString().split("T")[0],
    pending: !!row.pending,
    label: {
      budget_id: row.label_budget_id,
      category_id: row.label_category_id,
      memo: row.label_memo,
    },
    location: {
      address: null,
      city: row.location_city || null,
      region: row.location_region || null,
      postal_code: null,
      country: row.location_country || null,
      store_number: null,
      lat: null,
      lon: null,
    },
    payment_meta: {
      reference_number: null,
      ppd_id: null,
      payee: null,
      by_order_of: null,
      payer: null,
      payment_method: null,
      payment_processor: null,
      reason: null,
    },
    pending_transaction_id: row.pending_transaction_id ?? null,
    category_id: null,
    category: null,
    account_owner: null,
    unofficial_currency_code: null,
    payment_channel:
      (row.payment_channel as TransactionPaymentChannelEnum) ||
      TransactionPaymentChannelEnum.InStore,
    authorized_date: null,
    authorized_datetime: null,
    datetime: null,
    transaction_code: null,
  };
}

/**
 * Updates or inserts transactions associated with given user.
 */
export const upsertTransactions = async (
  user: MaskedUser,
  transactions: PartialTransaction[],
  upsert: boolean = true,
) => {
  if (!transactions.length) return [];
  const { user_id } = user;
  const results: { update: { _id: string }; status: number }[] = [];

  for (const tx of transactions) {
    const row = transactionToRow(tx);
    row.user_id = user_id;

    try {
      if (upsert) {
        const columns = Object.keys(row);
        const values = Object.values(row);
        const placeholders = values.map((_, i) => `$${i + 1}`);

        const updateClauses = columns
          .filter((col) => col !== "transaction_id" && col !== "user_id")
          .map((col) => `${col} = EXCLUDED.${col}`);
        updateClauses.push("updated = CURRENT_TIMESTAMP");

        const query = `
          INSERT INTO transactions (${columns.join(", ")}, updated)
          VALUES (${placeholders.join(", ")}, CURRENT_TIMESTAMP)
          ON CONFLICT (transaction_id) DO UPDATE SET
            ${updateClauses.join(", ")}
          WHERE transactions.user_id = $${columns.indexOf("user_id") + 1}
          RETURNING transaction_id
        `;

        const result = await pool.query(query, values);
        results.push({
          update: { _id: tx.transaction_id },
          status: result.rowCount ? 200 : 404,
        });
      } else {
        const updateData = { ...row };
        delete updateData.transaction_id;
        delete updateData.user_id;

        const queryResult = buildUpdateQuery(
          "transactions",
          "transaction_id",
          tx.transaction_id,
          updateData,
          { additionalWhere: { column: "user_id", value: user_id }, returning: ["transaction_id"] },
        );

        if (queryResult) {
          const result = await pool.query(queryResult.query, queryResult.values);
          results.push({
            update: { _id: tx.transaction_id },
            status: result.rowCount ? 200 : 404,
          });
        } else {
          results.push({
            update: { _id: tx.transaction_id },
            status: 304,
          });
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to upsert transaction ${tx.transaction_id}:`, message);
      results.push({
        update: { _id: tx.transaction_id },
        status: 500,
      });
    }
  }

  return results;
};

/**
 * Retrieves transactions for a user with optional filters.
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
  } = {},
): Promise<JSONTransaction[]> => {
  const { user_id } = user;
  const conditions: string[] = ["user_id = $1", "(is_deleted IS NULL OR is_deleted = FALSE)"];
  const values: (string | number | boolean)[] = [user_id];
  let paramIndex = 2;

  if (options.account_id) {
    conditions.push(`account_id = $${paramIndex}`);
    values.push(options.account_id);
    paramIndex++;
  }

  if (options.startDate) {
    conditions.push(`date >= $${paramIndex}`);
    values.push(options.startDate);
    paramIndex++;
  }

  if (options.endDate) {
    conditions.push(`date <= $${paramIndex}`);
    values.push(options.endDate);
    paramIndex++;
  }

  if (options.pending !== undefined) {
    conditions.push(`pending = $${paramIndex}`);
    values.push(options.pending);
    paramIndex++;
  }

  let query = `SELECT * FROM transactions WHERE ${conditions.join(" AND ")} ORDER BY date DESC`;

  if (options.limit) {
    query += ` LIMIT $${paramIndex}`;
    values.push(options.limit);
    paramIndex++;
  }

  if (options.offset) {
    query += ` OFFSET $${paramIndex}`;
    values.push(options.offset);
  }

  const result = await pool.query(query, values);
  return result.rows.map(rowToTransaction);
};

/**
 * Gets a single transaction by ID.
 */
export const getTransaction = async (
  user: MaskedUser,
  transaction_id: string,
): Promise<JSONTransaction | null> => {
  const { user_id } = user;
  const result = await pool.query(
    `SELECT * FROM transactions WHERE transaction_id = $1 AND user_id = $2 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [transaction_id, user_id],
  );
  return result.rows.length > 0 ? rowToTransaction(result.rows[0]) : null;
};

/**
 * Deletes transactions (soft delete).
 */
export const deleteTransactions = async (
  user: MaskedUser,
  transaction_ids: string[],
): Promise<{ deleted: number }> => {
  if (!transaction_ids.length) return { deleted: 0 };
  const { user_id } = user;

  const placeholders = transaction_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `UPDATE transactions SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP 
     WHERE transaction_id IN (${placeholders}) AND user_id = $1
     RETURNING transaction_id`,
    [user_id, ...transaction_ids],
  );

  return { deleted: result.rowCount || 0 };
};

// =====================================
// Investment Transactions
// =====================================

function investmentTxToRow(
  tx: Partial<JSONInvestmentTransaction>,
): Partial<InvestmentTransactionRow> {
  const row: Partial<InvestmentTransactionRow> = {};

  if (tx.investment_transaction_id !== undefined)
    row.investment_transaction_id = tx.investment_transaction_id;
  if (tx.account_id !== undefined) row.account_id = tx.account_id;
  if (tx.security_id !== undefined) row.security_id = tx.security_id;
  if (tx.date !== undefined) row.date = tx.date;
  if (tx.name !== undefined) row.name = tx.name;
  if (tx.amount !== undefined) row.amount = tx.amount;
  if (tx.quantity !== undefined) row.quantity = tx.quantity;
  if (tx.iso_currency_code !== undefined) row.iso_currency_code = tx.iso_currency_code;
  if (tx.price !== undefined) row.price = tx.price;
  if (tx.type !== undefined) row.type = tx.type;

  // Store full provider object in raw
  row.raw = JSON.stringify(tx);

  return row;
}

function rowToInvestmentTx(row: InvestmentTransactionRow): JSONInvestmentTransaction {
  return {
    investment_transaction_id: row.investment_transaction_id,
    account_id: row.account_id,
    security_id: row.security_id || null,
    date: row.date,
    name: row.name || "Unknown",
    quantity: row.quantity ? Number(row.quantity) : 0,
    amount: row.amount ? Number(row.amount) : 0,
    price: row.price ? Number(row.price) : 0,
    iso_currency_code: row.iso_currency_code || null,
    type: (row.type as InvestmentTransactionType) || InvestmentTransactionType.Transfer,
    fees: null,
    subtype: (row.subtype as InvestmentTransactionSubtype) || InvestmentTransactionSubtype.Transfer,
    unofficial_currency_code: null,
    label: {
      budget_id: row.label_budget_id,
      category_id: row.label_category_id,
      memo: row.label_memo,
    },
  };
}

export const upsertInvestmentTransactions = async (
  user: MaskedUser,
  transactions: (Partial<JSONInvestmentTransaction> & { investment_transaction_id: string })[],
  upsert: boolean = true,
) => {
  if (!transactions.length) return [];
  const { user_id } = user;
  const results: { update: { _id: string }; status: number }[] = [];

  for (const tx of transactions) {
    const row = investmentTxToRow(tx);
    row.user_id = user_id;

    try {
      if (upsert) {
        const columns = Object.keys(row);
        const values = Object.values(row);
        const placeholders = values.map((_, i) => `$${i + 1}`);

        const updateClauses = columns
          .filter((col) => col !== "investment_transaction_id" && col !== "user_id")
          .map((col) => `${col} = EXCLUDED.${col}`);
        updateClauses.push("updated = CURRENT_TIMESTAMP");

        const query = `
        INSERT INTO investment_transactions (${columns.join(", ")}, updated)
        VALUES (${placeholders.join(", ")}, CURRENT_TIMESTAMP)
        ON CONFLICT (investment_transaction_id) DO UPDATE SET
          ${updateClauses.join(", ")}
        RETURNING investment_transaction_id
      `;

        const result = await pool.query(query, values);
        results.push({
          update: { _id: tx.investment_transaction_id },
          status: result.rowCount ? 200 : 404,
        });
      } else {
        const updateData = { ...row };
        delete updateData.investment_transaction_id;
        delete updateData.user_id;

        const queryResult = buildUpdateQuery(
          "investment_transactions",
          "investment_transaction_id",
          tx.investment_transaction_id,
          updateData,
          {
            additionalWhere: { column: "user_id", value: user_id },
            returning: ["investment_transaction_id"],
          },
        );

        if (queryResult) {
          const result = await pool.query(queryResult.query, queryResult.values);
          results.push({
            update: { _id: tx.investment_transaction_id },
            status: result.rowCount ? 200 : 404,
          });
        } else {
          results.push({
            update: { _id: tx.investment_transaction_id },
            status: 304,
          });
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to upsert investment transaction:`, message);
      results.push({
        update: { _id: tx.investment_transaction_id },
        status: 500,
      });
    }
  }

  return results;
};

export const getInvestmentTransactions = async (
  user: MaskedUser,
  options: { account_id?: string; startDate?: string; endDate?: string } = {},
): Promise<JSONInvestmentTransaction[]> => {
  const { user_id } = user;
  const conditions: string[] = ["user_id = $1", "(is_deleted IS NULL OR is_deleted = FALSE)"];
  const values: string[] = [user_id];
  let paramIndex = 2;

  if (options.account_id) {
    conditions.push(`account_id = $${paramIndex}`);
    values.push(options.account_id);
    paramIndex++;
  }

  if (options.startDate) {
    conditions.push(`date >= $${paramIndex}`);
    values.push(options.startDate);
    paramIndex++;
  }

  if (options.endDate) {
    conditions.push(`date <= $${paramIndex}`);
    values.push(options.endDate);
    paramIndex++;
  }

  const result = await pool.query(
    `SELECT * FROM investment_transactions WHERE ${conditions.join(" AND ")} ORDER BY date DESC`,
    values,
  );
  return result.rows.map(rowToInvestmentTx);
};

/**
 * Deletes investment transactions (soft delete).
 */
export const deleteInvestmentTransactions = async (
  user: MaskedUser,
  investment_transaction_ids: string[],
): Promise<{ deleted: number }> => {
  if (!investment_transaction_ids.length) return { deleted: 0 };
  const { user_id } = user;

  const placeholders = investment_transaction_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `UPDATE investment_transactions SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP 
     WHERE investment_transaction_id IN (${placeholders}) AND user_id = $1
     RETURNING investment_transaction_id`,
    [user_id, ...investment_transaction_ids],
  );

  return { deleted: result.rowCount || 0 };
};

/**
 * Searches transactions by account IDs within a date range.
 */
export const searchTransactionsByAccountId = async (
  user: MaskedUser,
  account_ids: string[],
  range?: { start: Date; end: Date },
): Promise<{
  transactions: JSONTransaction[];
  investment_transactions: JSONInvestmentTransaction[];
}> => {
  if (!account_ids.length) return { transactions: [], investment_transactions: [] };
  const { user_id } = user;

  const placeholders = account_ids.map((_, i) => `$${i + 2}`).join(", ");
  const baseConditions = [
    "user_id = $1",
    `account_id IN (${placeholders})`,
    "(is_deleted IS NULL OR is_deleted = FALSE)",
  ];
  const values: string[] = [user_id, ...account_ids];
  let paramIndex = account_ids.length + 2;

  const rangeConditions: string[] = [];
  if (range) {
    rangeConditions.push(`date >= $${paramIndex}`);
    values.push(range.start.toISOString().split("T")[0]);
    paramIndex++;

    rangeConditions.push(`date <= $${paramIndex}`);
    values.push(range.end.toISOString().split("T")[0]);
  }

  const allConditions = [...baseConditions, ...rangeConditions];

  const [txResult, invTxResult] = await Promise.all([
    pool.query(
      `SELECT * FROM transactions WHERE ${allConditions.join(" AND ")} ORDER BY date DESC`,
      values,
    ),
    pool.query(
      `SELECT * FROM investment_transactions WHERE ${allConditions.join(" AND ")} ORDER BY date DESC`,
      values,
    ),
  ]);

  return {
    transactions: txResult.rows.map(rowToTransaction),
    investment_transactions: invTxResult.rows.map(rowToInvestmentTx),
  };
};

// =====================================
// Split Transactions (NO CHANGE - user-created, no provider data)
// =====================================

function splitTxToRow(tx: Partial<JSONSplitTransaction>): Partial<SplitTransactionRow> {
  const row: Partial<SplitTransactionRow> = {};

  if (tx.split_transaction_id !== undefined) row.split_transaction_id = tx.split_transaction_id;
  if (tx.transaction_id !== undefined) row.transaction_id = tx.transaction_id;
  if (tx.account_id !== undefined) row.account_id = tx.account_id;
  if (tx.amount !== undefined) row.amount = tx.amount;
  if (tx.date !== undefined) row.date = tx.date;
  if (tx.custom_name !== undefined) row.custom_name = tx.custom_name;

  // Flatten label
  if (tx.label) {
    if (tx.label.budget_id !== undefined) row.label_budget_id = tx.label.budget_id;
    if (tx.label.category_id !== undefined) row.label_category_id = tx.label.category_id;
    if (tx.label.memo !== undefined) row.label_memo = tx.label.memo;
  }

  return row;
}

function rowToSplitTx(row: SplitTransactionRow): JSONSplitTransaction {
  return {
    split_transaction_id: row.split_transaction_id,
    user_id: row.user_id,
    transaction_id: row.transaction_id,
    account_id: row.account_id,
    amount: row.amount ? Number(row.amount) : 0,
    date: row.date,
    custom_name: row.custom_name,
    label: {
      budget_id: row.label_budget_id,
      category_id: row.label_category_id,
      memo: row.label_memo,
    },
  } as JSONSplitTransaction;
}

export const upsertSplitTransactions = async (
  user: MaskedUser,
  transactions: Partial<JSONSplitTransaction>[],
) => {
  if (!transactions.length) return [];
  const { user_id } = user;
  const results: { update: { _id: string }; status: number }[] = [];

  for (const tx of transactions) {
    const row = splitTxToRow(tx);
    row.user_id = user_id;

    try {
      const columns = Object.keys(row);
      const values = Object.values(row);
      const placeholders = values.map((_, i) => `$${i + 1}`);

      let query: string;
      if (row.split_transaction_id) {
        const updateClauses = columns
          .filter((col) => col !== "split_transaction_id" && col !== "user_id")
          .map((col) => `${col} = EXCLUDED.${col}`);
        updateClauses.push("updated = CURRENT_TIMESTAMP");

        query = `
          INSERT INTO split_transactions (${columns.join(", ")}, updated)
          VALUES (${placeholders.join(", ")}, CURRENT_TIMESTAMP)
          ON CONFLICT (split_transaction_id) DO UPDATE SET
            ${updateClauses.join(", ")}
          RETURNING split_transaction_id
        `;
      } else {
        const insertColumns = columns.filter((c) => c !== "split_transaction_id");
        const insertValues = values.filter((_, i) => columns[i] !== "split_transaction_id");
        const insertPlaceholders = insertValues.map((_, i) => `$${i + 1}`);

        query = `
          INSERT INTO split_transactions (${insertColumns.join(", ")}, updated)
          VALUES (${insertPlaceholders.join(", ")}, CURRENT_TIMESTAMP)
          RETURNING split_transaction_id
        `;
        values.length = 0;
        values.push(...insertValues);
      }

      const result = await pool.query(query, values);
      const id = result.rows[0]?.split_transaction_id || tx.split_transaction_id;
      results.push({
        update: { _id: id },
        status: result.rowCount ? 200 : 404,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to upsert split transaction:`, message);
      results.push({
        update: { _id: tx.split_transaction_id || "unknown" },
        status: 500,
      });
    }
  }

  return results;
};

export const getSplitTransactions = async (
  user: MaskedUser,
  transaction_id?: string,
): Promise<JSONSplitTransaction[]> => {
  const { user_id } = user;

  if (transaction_id) {
    const result = await pool.query(
      `SELECT * FROM split_transactions 
       WHERE transaction_id = $1 AND user_id = $2 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
      [transaction_id, user_id],
    );
    return result.rows.map(rowToSplitTx);
  }

  const result = await pool.query(
    `SELECT * FROM split_transactions WHERE user_id = $1 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [user_id],
  );
  return result.rows.map(rowToSplitTx);
};

export const deleteSplitTransactions = async (
  user: MaskedUser,
  split_transaction_ids: string[],
): Promise<{ deleted: number }> => {
  if (!split_transaction_ids.length) return { deleted: 0 };
  const { user_id } = user;

  const placeholders = split_transaction_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `UPDATE split_transactions SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP 
     WHERE split_transaction_id IN (${placeholders}) AND user_id = $1
     RETURNING split_transaction_id`,
    [user_id, ...split_transaction_ids],
  );

  return { deleted: result.rowCount || 0 };
};

export const deleteSplitTransactionsByTransactionId = async (
  user: MaskedUser,
  transaction_id: string,
): Promise<{ deleted: number }> => {
  const { user_id } = user;

  const result = await pool.query(
    `UPDATE split_transactions SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP 
     WHERE transaction_id = $1 AND user_id = $2
     RETURNING split_transaction_id`,
    [transaction_id, user_id],
  );

  return { deleted: result.rowCount || 0 };
};

export const searchTransactions = async (
  user: MaskedUser,
  options: SearchTransactionsOptions = {},
): Promise<{
  transactions: JSONTransaction[];
  investment_transactions: JSONInvestmentTransaction[];
}> => {
  const { user_id } = user;
  const conditions: string[] = ["user_id = $1", "(is_deleted IS NULL OR is_deleted = FALSE)"];
  const values: (string | number | boolean)[] = [user_id];
  let paramIndex = 2;

  if (options.account_id) {
    conditions.push(`account_id = $${paramIndex}`);
    values.push(options.account_id);
    paramIndex++;
  }

  if (options.account_ids && options.account_ids.length > 0) {
    const placeholders = options.account_ids.map((_, i) => `$${paramIndex + i}`).join(", ");
    conditions.push(`account_id IN (${placeholders})`);
    values.push(...options.account_ids);
    paramIndex += options.account_ids.length;
  }

  if (options.startDate) {
    conditions.push(`date >= $${paramIndex}`);
    values.push(options.startDate);
    paramIndex++;
  }

  if (options.endDate) {
    conditions.push(`date <= $${paramIndex}`);
    values.push(options.endDate);
    paramIndex++;
  }

  if (options.pending !== undefined) {
    conditions.push(`pending = $${paramIndex}`);
    values.push(options.pending);
    paramIndex++;
  }

  let txQuery = `SELECT * FROM transactions WHERE ${conditions.join(" AND ")} ORDER BY date DESC`;
  let invTxQuery = `SELECT * FROM investment_transactions WHERE ${conditions.join(" AND ")} ORDER BY date DESC`;

  if (options.limit) {
    txQuery += ` LIMIT $${paramIndex}`;
    invTxQuery += ` LIMIT $${paramIndex}`;
    values.push(options.limit);
    paramIndex++;
  }

  if (options.offset) {
    txQuery += ` OFFSET $${paramIndex}`;
    invTxQuery += ` OFFSET $${paramIndex}`;
    values.push(options.offset);
  }

  const [txResult, invTxResult] = await Promise.all([
    pool.query(txQuery, values),
    pool.query(invTxQuery, values),
  ]);

  return {
    transactions: txResult.rows.map(rowToTransaction),
    investment_transactions: invTxResult.rows.map(rowToInvestmentTx),
  };
};

export const searchSplitTransactions = async (
  user: MaskedUser,
  options: SearchSplitTransactionsOptions = {},
): Promise<JSONSplitTransaction[]> => {
  const { user_id } = user;
  const conditions: string[] = ["user_id = $1", "(is_deleted IS NULL OR is_deleted = FALSE)"];
  const values: string[] = [user_id];
  let paramIndex = 2;

  if (options.transaction_id) {
    conditions.push(`transaction_id = $${paramIndex}`);
    values.push(options.transaction_id);
    paramIndex++;
  }

  if (options.account_id) {
    conditions.push(`account_id = $${paramIndex}`);
    values.push(options.account_id);
    paramIndex++;
  }

  const result = await pool.query(
    `SELECT * FROM split_transactions WHERE ${conditions.join(" AND ")}`,
    values,
  );
  return result.rows.map(rowToSplitTx);
};

export const createSplitTransaction = async (
  user: MaskedUser,
  data: Partial<JSONSplitTransaction>,
): Promise<JSONSplitTransaction | null> => {
  const { user_id } = user;

  try {
    const result = await pool.query(
      `INSERT INTO split_transactions (
        user_id, transaction_id, account_id, amount, date, custom_name,
        label_budget_id, label_category_id, label_memo, updated
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
      RETURNING *`,
      [
        user_id,
        data.transaction_id,
        data.account_id,
        data.amount || 0,
        data.date,
        data.custom_name || "",
        data.label?.budget_id,
        data.label?.category_id,
        data.label?.memo,
      ],
    );

    return result.rows.length > 0 ? rowToSplitTx(result.rows[0]) : null;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Failed to create split transaction:", message);
    return null;
  }
};

export const getOldestTransactionDate = async (user: MaskedUser): Promise<string | null> => {
  const { user_id } = user;
  const result = await pool.query(
    `SELECT MIN(date) as oldest_date FROM transactions 
     WHERE user_id = $1 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [user_id],
  );
  return result.rows[0]?.oldest_date || null;
};
