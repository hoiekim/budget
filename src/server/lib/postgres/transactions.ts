import { JSONTransaction, JSONInvestmentTransaction, JSONSplitTransaction } from "common";
import { pool } from "./client";
import { MaskedUser } from "./users";
import { buildUpdateQuery } from "./utils";

export type PartialTransaction = { transaction_id: string } & Partial<JSONTransaction>;

/**
 * Converts an ES-style transaction object to flat Postgres columns.
 */
function transactionToRow(tx: PartialTransaction): Record<string, any> {
  const row: Record<string, any> = {};
  
  // Direct mappings
  if (tx.transaction_id !== undefined) row.transaction_id = tx.transaction_id;
  if (tx.account_id !== undefined) row.account_id = tx.account_id;
  if (tx.pending_transaction_id !== undefined) row.pending_transaction_id = tx.pending_transaction_id;
  if (tx.category_id !== undefined) row.category_id = tx.category_id;
  if (tx.category !== undefined) row.category = tx.category;
  if (tx.account_owner !== undefined) row.account_owner = tx.account_owner;
  if (tx.name !== undefined) row.name = tx.name;
  if (tx.amount !== undefined) row.amount = tx.amount;
  if (tx.iso_currency_code !== undefined) row.iso_currency_code = tx.iso_currency_code;
  if (tx.unofficial_currency_code !== undefined) row.unofficial_currency_code = tx.unofficial_currency_code;
  if (tx.date !== undefined) row.date = tx.date;
  if (tx.pending !== undefined) row.pending = tx.pending;
  if (tx.payment_channel !== undefined) row.payment_channel = tx.payment_channel;
  if (tx.authorized_date !== undefined) row.authorized_date = tx.authorized_date;
  if (tx.authorized_datetime !== undefined) row.authorized_datetime = tx.authorized_datetime;
  if (tx.datetime !== undefined) row.datetime = tx.datetime;
  if (tx.transaction_code !== undefined) row.transaction_code = tx.transaction_code;
  
  // Flatten location
  if (tx.location) {
    if (tx.location.address !== undefined) row.location_address = tx.location.address;
    if (tx.location.city !== undefined) row.location_city = tx.location.city;
    if (tx.location.region !== undefined) row.location_region = tx.location.region;
    if (tx.location.postal_code !== undefined) row.location_postal_code = tx.location.postal_code;
    if (tx.location.country !== undefined) row.location_country = tx.location.country;
    if (tx.location.store_number !== undefined) row.location_store_number = tx.location.store_number;
    if (tx.location.lat !== undefined) row.location_lat = tx.location.lat;
    if (tx.location.lon !== undefined) row.location_lon = tx.location.lon;
  }
  
  // Flatten payment_meta
  if (tx.payment_meta) {
    if (tx.payment_meta.reference_number !== undefined) row.payment_meta_reference_number = tx.payment_meta.reference_number;
    if (tx.payment_meta.ppd_id !== undefined) row.payment_meta_ppd_id = tx.payment_meta.ppd_id;
    if (tx.payment_meta.payee !== undefined) row.payment_meta_payee = tx.payment_meta.payee;
    if (tx.payment_meta.by_order_of !== undefined) row.payment_meta_by_order_of = tx.payment_meta.by_order_of;
    if (tx.payment_meta.payer !== undefined) row.payment_meta_payer = tx.payment_meta.payer;
    if (tx.payment_meta.payment_method !== undefined) row.payment_meta_payment_method = tx.payment_meta.payment_method;
    if (tx.payment_meta.payment_processor !== undefined) row.payment_meta_payment_processor = tx.payment_meta.payment_processor;
    if (tx.payment_meta.reason !== undefined) row.payment_meta_reason = tx.payment_meta.reason;
  }
  
  // Flatten label
  if (tx.label) {
    if (tx.label.budget_id !== undefined) row.label_budget_id = tx.label.budget_id;
    if (tx.label.category_id !== undefined) row.label_category_id = tx.label.category_id;
    if (tx.label.memo !== undefined) row.label_memo = tx.label.memo;
  }
  
  return row;
}

/**
 * Converts a Postgres row to ES-style transaction object.
 */
function rowToTransaction(row: Record<string, any>): JSONTransaction {
  return {
    transaction_id: row.transaction_id,
    user_id: row.user_id,
    account_id: row.account_id,
    pending_transaction_id: row.pending_transaction_id,
    category_id: row.category_id,
    category: row.category,
    account_owner: row.account_owner,
    name: row.name,
    amount: parseFloat(row.amount),
    iso_currency_code: row.iso_currency_code,
    unofficial_currency_code: row.unofficial_currency_code,
    date: row.date,
    pending: row.pending,
    payment_channel: row.payment_channel,
    authorized_date: row.authorized_date,
    authorized_datetime: row.authorized_datetime,
    datetime: row.datetime,
    transaction_code: row.transaction_code,
    location: {
      address: row.location_address,
      city: row.location_city,
      region: row.location_region,
      postal_code: row.location_postal_code,
      country: row.location_country,
      store_number: row.location_store_number,
      lat: row.location_lat,
      lon: row.location_lon,
    },
    payment_meta: {
      reference_number: row.payment_meta_reference_number,
      ppd_id: row.payment_meta_ppd_id,
      payee: row.payment_meta_payee,
      by_order_of: row.payment_meta_by_order_of,
      payer: row.payment_meta_payer,
      payment_method: row.payment_meta_payment_method,
      payment_processor: row.payment_meta_payment_processor,
      reason: row.payment_meta_reason,
    },
    label: {
      budget_id: row.label_budget_id,
      category_id: row.label_category_id,
      memo: row.label_memo,
    },
  } as JSONTransaction;
}

/**
 * Updates or inserts transactions associated with given user.
 */
export const upsertTransactions = async (
  user: MaskedUser,
  transactions: PartialTransaction[],
  upsert: boolean = true
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
          .filter(col => col !== "transaction_id" && col !== "user_id")
          .map(col => `${col} = EXCLUDED.${col}`);
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
          { additionalWhere: { column: "user_id", value: user_id }, returning: ["transaction_id"] }
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
    } catch (error: any) {
      console.error(`Failed to upsert transaction ${tx.transaction_id}:`, error.message);
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
  } = {}
): Promise<JSONTransaction[]> => {
  const { user_id } = user;
  const conditions: string[] = ["user_id = $1", "(is_deleted IS NULL OR is_deleted = FALSE)"];
  const values: any[] = [user_id];
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
  transaction_id: string
): Promise<JSONTransaction | null> => {
  const { user_id } = user;
  const result = await pool.query(
    `SELECT * FROM transactions WHERE transaction_id = $1 AND user_id = $2 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [transaction_id, user_id]
  );
  return result.rows.length > 0 ? rowToTransaction(result.rows[0]) : null;
};

/**
 * Deletes transactions (soft delete).
 */
export const deleteTransactions = async (
  user: MaskedUser,
  transaction_ids: string[]
): Promise<{ deleted: number }> => {
  if (!transaction_ids.length) return { deleted: 0 };
  const { user_id } = user;
  
  const placeholders = transaction_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `UPDATE transactions SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP 
     WHERE transaction_id IN (${placeholders}) AND user_id = $1
     RETURNING transaction_id`,
    [user_id, ...transaction_ids]
  );
  
  return { deleted: result.rowCount || 0 };
};

// =====================================
// Investment Transactions
// =====================================

function investmentTxToRow(tx: Partial<JSONInvestmentTransaction>): Record<string, any> {
  const row: Record<string, any> = {};
  
  if (tx.investment_transaction_id !== undefined) row.investment_transaction_id = tx.investment_transaction_id;
  if (tx.account_id !== undefined) row.account_id = tx.account_id;
  if (tx.security_id !== undefined) row.security_id = tx.security_id;
  if (tx.date !== undefined) row.date = tx.date;
  if (tx.name !== undefined) row.name = tx.name;
  if (tx.quantity !== undefined) row.quantity = tx.quantity;
  if (tx.amount !== undefined) row.amount = tx.amount;
  if (tx.price !== undefined) row.price = tx.price;
  if (tx.fees !== undefined) row.fees = tx.fees;
  if (tx.type !== undefined) row.type = tx.type;
  if (tx.subtype !== undefined) row.subtype = tx.subtype;
  if (tx.iso_currency_code !== undefined) row.iso_currency_code = tx.iso_currency_code;
  if (tx.unofficial_currency_code !== undefined) row.unofficial_currency_code = tx.unofficial_currency_code;
  
  return row;
}

function rowToInvestmentTx(row: Record<string, any>): JSONInvestmentTransaction {
  return {
    investment_transaction_id: row.investment_transaction_id,
    user_id: row.user_id,
    account_id: row.account_id,
    security_id: row.security_id,
    date: row.date,
    name: row.name,
    quantity: parseFloat(row.quantity),
    amount: parseFloat(row.amount),
    price: parseFloat(row.price),
    fees: row.fees ? parseFloat(row.fees) : undefined,
    type: row.type,
    subtype: row.subtype,
    iso_currency_code: row.iso_currency_code,
    unofficial_currency_code: row.unofficial_currency_code,
  } as JSONInvestmentTransaction;
}

export const upsertInvestmentTransactions = async (
  user: MaskedUser,
  transactions: (Partial<JSONInvestmentTransaction> & { investment_transaction_id: string })[]
) => {
  if (!transactions.length) return [];
  const { user_id } = user;
  const results: { update: { _id: string }; status: number }[] = [];

  for (const tx of transactions) {
    const row = investmentTxToRow(tx);
    row.user_id = user_id;
    
    try {
      const columns = Object.keys(row);
      const values = Object.values(row);
      const placeholders = values.map((_, i) => `$${i + 1}`);
      
      const updateClauses = columns
        .filter(col => col !== "investment_transaction_id" && col !== "user_id")
        .map(col => `${col} = EXCLUDED.${col}`);
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
    } catch (error: any) {
      console.error(`Failed to upsert investment transaction:`, error.message);
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
  options: { account_id?: string; startDate?: string; endDate?: string } = {}
): Promise<JSONInvestmentTransaction[]> => {
  const { user_id } = user;
  const conditions: string[] = ["user_id = $1", "(is_deleted IS NULL OR is_deleted = FALSE)"];
  const values: any[] = [user_id];
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
    values
  );
  return result.rows.map(rowToInvestmentTx);
};

/**
 * Deletes investment transactions (soft delete).
 */
export const deleteInvestmentTransactions = async (
  user: MaskedUser,
  investment_transaction_ids: string[]
): Promise<{ deleted: number }> => {
  if (!investment_transaction_ids.length) return { deleted: 0 };
  const { user_id } = user;
  
  const placeholders = investment_transaction_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `UPDATE investment_transactions SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP 
     WHERE investment_transaction_id IN (${placeholders}) AND user_id = $1
     RETURNING investment_transaction_id`,
    [user_id, ...investment_transaction_ids]
  );
  
  return { deleted: result.rowCount || 0 };
};

/**
 * Searches transactions by account IDs within a date range.
 */
export const searchTransactionsByAccountId = async (
  user: MaskedUser,
  account_ids: string[],
  range?: { start: Date; end: Date }
): Promise<JSONTransaction[]> => {
  if (!account_ids.length) return [];
  const { user_id } = user;
  
  const placeholders = account_ids.map((_, i) => `$${i + 2}`).join(", ");
  const conditions = [
    "user_id = $1",
    `account_id IN (${placeholders})`,
    "(is_deleted IS NULL OR is_deleted = FALSE)"
  ];
  const values: any[] = [user_id, ...account_ids];
  let paramIndex = account_ids.length + 2;
  
  if (range) {
    conditions.push(`date >= $${paramIndex}`);
    values.push(range.start.toISOString().split('T')[0]);
    paramIndex++;
    
    conditions.push(`date <= $${paramIndex}`);
    values.push(range.end.toISOString().split('T')[0]);
  }
  
  const result = await pool.query(
    `SELECT * FROM transactions WHERE ${conditions.join(" AND ")} ORDER BY date DESC`,
    values
  );
  return result.rows.map(rowToTransaction);
};

// =====================================
// Split Transactions
// =====================================

function splitTxToRow(tx: Partial<JSONSplitTransaction>): Record<string, any> {
  const row: Record<string, any> = {};
  
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

function rowToSplitTx(row: Record<string, any>): JSONSplitTransaction {
  return {
    split_transaction_id: row.split_transaction_id,
    user_id: row.user_id,
    transaction_id: row.transaction_id,
    account_id: row.account_id,
    amount: parseFloat(row.amount),
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
  transactions: Partial<JSONSplitTransaction>[]
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
      
      // Handle insert without split_transaction_id (generate UUID)
      let query: string;
      if (row.split_transaction_id) {
        const updateClauses = columns
          .filter(col => col !== "split_transaction_id" && col !== "user_id")
          .map(col => `${col} = EXCLUDED.${col}`);
        updateClauses.push("updated = CURRENT_TIMESTAMP");
        
        query = `
          INSERT INTO split_transactions (${columns.join(", ")}, updated)
          VALUES (${placeholders.join(", ")}, CURRENT_TIMESTAMP)
          ON CONFLICT (split_transaction_id) DO UPDATE SET
            ${updateClauses.join(", ")}
          RETURNING split_transaction_id
        `;
      } else {
        // Remove split_transaction_id from columns/values for auto-generation
        const insertColumns = columns.filter(c => c !== "split_transaction_id");
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
    } catch (error: any) {
      console.error(`Failed to upsert split transaction:`, error.message);
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
  transaction_id?: string
): Promise<JSONSplitTransaction[]> => {
  const { user_id } = user;
  
  if (transaction_id) {
    const result = await pool.query(
      `SELECT * FROM split_transactions 
       WHERE transaction_id = $1 AND user_id = $2 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
      [transaction_id, user_id]
    );
    return result.rows.map(rowToSplitTx);
  }
  
  const result = await pool.query(
    `SELECT * FROM split_transactions WHERE user_id = $1 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [user_id]
  );
  return result.rows.map(rowToSplitTx);
};

export const deleteSplitTransactions = async (
  user: MaskedUser,
  split_transaction_ids: string[]
): Promise<{ deleted: number }> => {
  if (!split_transaction_ids.length) return { deleted: 0 };
  const { user_id } = user;
  
  const placeholders = split_transaction_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `UPDATE split_transactions SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP 
     WHERE split_transaction_id IN (${placeholders}) AND user_id = $1
     RETURNING split_transaction_id`,
    [user_id, ...split_transaction_ids]
  );
  
  return { deleted: result.rowCount || 0 };
};

/**
 * Deletes split transactions by parent transaction ID (soft delete).
 */
export const deleteSplitTransactionsByTransactionId = async (
  user: MaskedUser,
  transaction_id: string
): Promise<{ deleted: number }> => {
  const { user_id } = user;
  
  const result = await pool.query(
    `UPDATE split_transactions SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP 
     WHERE transaction_id = $1 AND user_id = $2
     RETURNING split_transaction_id`,
    [transaction_id, user_id]
  );
  
  return { deleted: result.rowCount || 0 };
};
