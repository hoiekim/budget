import { JSONTransaction, JSONInvestmentTransaction, JSONSplitTransaction } from "common";
import { pool } from "./client";
import { MaskedUser } from "./users";
import { buildUpdateQuery } from "./utils";

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
  user_id?: string | null;
  account_id?: string | null;
  name?: string | null;
  amount?: string | number | null;
  date?: string | null;
  pending?: boolean | null;
  label_budget_id?: string | null;
  label_category_id?: string | null;
  label_memo?: string | null;
  raw?: string | null;
  updated?: Date | null;
  is_deleted?: boolean | null;
}

interface InvestmentTransactionRow {
  investment_transaction_id: string;
  user_id?: string | null;
  account_id?: string | null;
  security_id?: string | null;
  date?: string | null;
  name?: string | null;
  amount?: string | number | null;
  quantity?: string | number | null;
  price?: string | number | null;
  type?: string | null;
  raw?: string | null;
  updated?: Date | null;
  is_deleted?: boolean | null;
}

interface SplitTransactionRow {
  split_transaction_id: string;
  user_id?: string | null;
  transaction_id?: string | null;
  account_id?: string | null;
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

  if (tx.transaction_id !== undefined) row.transaction_id = tx.transaction_id;
  if (tx.account_id !== undefined) row.account_id = tx.account_id;
  if (tx.name !== undefined) row.name = tx.name;
  if (tx.amount !== undefined) row.amount = tx.amount;
  if (tx.date !== undefined) row.date = tx.date;
  if (tx.pending !== undefined) row.pending = tx.pending;

  // Flatten label (user-edited)
  if (tx.label) {
    if (tx.label.budget_id !== undefined) row.label_budget_id = tx.label.budget_id;
    if (tx.label.category_id !== undefined) row.label_category_id = tx.label.category_id;
    if (tx.label.memo !== undefined) row.label_memo = tx.label.memo;
  }

  // Store full provider object in raw (excluding label which is user-edited)
  const { label, ...providerData } = tx;
  row.raw = JSON.stringify(providerData);

  return row;
}

/**
 * Converts a Postgres row to transaction object.
 * Merges raw JSONB with user-edited label columns.
 */
function rowToTransaction(row: TransactionRow): JSONTransaction {
  // Start from raw JSONB if available, then overlay column values
  const raw = row.raw ? (typeof row.raw === "string" ? JSON.parse(row.raw) : row.raw) : {};

  return {
    ...raw,
    transaction_id: row.transaction_id,
    user_id: row.user_id,
    account_id: row.account_id ?? raw.account_id,
    name: row.name ?? raw.name,
    amount: row.amount != null ? Number(row.amount) : (raw.amount ?? 0),
    date: row.date ?? raw.date,
    pending: row.pending ?? raw.pending,
    // User-edited label always comes from columns (overrides raw)
    label: {
      budget_id: row.label_budget_id,
      category_id: row.label_category_id,
      memo: row.label_memo,
    },
    // Ensure nested objects have defaults if not in raw
    location: raw.location || {
      address: null,
      city: null,
      region: null,
      postal_code: null,
      country: null,
      store_number: null,
      lat: null,
      lon: null,
    },
    payment_meta: raw.payment_meta || {
      reference_number: null,
      ppd_id: null,
      payee: null,
      by_order_of: null,
      payer: null,
      payment_method: null,
      payment_processor: null,
      reason: null,
    },
    pending_transaction_id: raw.pending_transaction_id ?? null,
    category_id: raw.category_id ?? null,
    category: raw.category ?? null,
    account_owner: raw.account_owner ?? null,
    iso_currency_code: raw.iso_currency_code ?? null,
    unofficial_currency_code: raw.unofficial_currency_code ?? null,
    payment_channel: raw.payment_channel,
    authorized_date: raw.authorized_date ?? null,
    authorized_datetime: raw.authorized_datetime ?? null,
    datetime: raw.datetime ?? null,
    transaction_code: raw.transaction_code ?? null,
  } as JSONTransaction;
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
  if (tx.price !== undefined) row.price = tx.price;
  if (tx.type !== undefined) row.type = tx.type;

  // Store full provider object in raw
  row.raw = JSON.stringify(tx);

  return row;
}

function rowToInvestmentTx(row: InvestmentTransactionRow): JSONInvestmentTransaction {
  const raw = row.raw ? (typeof row.raw === "string" ? JSON.parse(row.raw) : row.raw) : {};

  return {
    ...raw,
    investment_transaction_id: row.investment_transaction_id,
    user_id: row.user_id,
    account_id: row.account_id ?? raw.account_id,
    security_id: row.security_id ?? raw.security_id,
    date: row.date ?? raw.date,
    name: row.name ?? raw.name,
    quantity: row.quantity != null ? Number(row.quantity) : (raw.quantity ?? 0),
    amount: row.amount != null ? Number(row.amount) : (raw.amount ?? 0),
    price: row.price != null ? Number(row.price) : (raw.price ?? 0),
    type: row.type ?? raw.type,
    // Fields from raw only
    fees: raw.fees != null ? Number(raw.fees) : undefined,
    subtype: raw.subtype,
    iso_currency_code: raw.iso_currency_code,
    unofficial_currency_code: raw.unofficial_currency_code,
  } as JSONInvestmentTransaction;
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
    amount: row.amount != null ? Number(row.amount) : 0,
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
