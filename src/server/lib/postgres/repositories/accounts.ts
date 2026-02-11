/**
 * Account repository - CRUD operations for accounts, holdings, institutions, securities.
 */

import { JSONAccount, JSONHolding, JSONInstitution, JSONSecurity } from "common";
import { pool } from "../client";
import {
  MaskedUser,
  AccountModel,
  HoldingModel,
  InstitutionModel,
  SecurityModel,
  ACCOUNTS,
  HOLDINGS,
  INSTITUTIONS,
  SECURITIES,
  ACCOUNT_ID,
  HOLDING_ID,
  INSTITUTION_ID,
  SECURITY_ID,
  USER_ID,
  ITEM_ID,
  TRANSACTIONS,
  INVESTMENT_TRANSACTIONS,
  SPLIT_TRANSACTIONS,
  SNAPSHOTS,
} from "../models";
import {
  buildUpsert,
  buildUpdate,
  buildSelectWithFilters,
  selectWithFilters,
  SOFT_DELETE_CONDITION,
  UpsertResult,
  successResult,
  errorResult,
  noChangeResult,
} from "../database";

// Types

export type PartialAccount = { account_id: string } & Partial<JSONAccount>;

// Query Helpers

const rowToAccount = (row: Record<string, unknown>): JSONAccount => new AccountModel(row).toJSON();
const rowToHolding = (row: Record<string, unknown>): JSONHolding => new HoldingModel(row).toJSON();
const rowToInstitution = (row: Record<string, unknown>): JSONInstitution =>
  new InstitutionModel(row).toJSON();
const rowToSecurity = (row: Record<string, unknown>): JSONSecurity => new SecurityModel(row).toJSON();

// Account Repository Functions

/**
 * Gets all accounts for a user.
 */
export const getAccounts = async (user: MaskedUser): Promise<JSONAccount[]> => {
  const rows = await selectWithFilters<Record<string, unknown>>(pool, ACCOUNTS, "*", {
    user_id: user.user_id,
  });
  return rows.map(rowToAccount);
};

/**
 * Gets a single account by ID.
 */
export const getAccount = async (
  user: MaskedUser,
  account_id: string
): Promise<JSONAccount | null> => {
  const rows = await selectWithFilters<Record<string, unknown>>(pool, ACCOUNTS, "*", {
    user_id: user.user_id,
    primaryKey: { column: ACCOUNT_ID, value: account_id },
  });
  return rows.length > 0 ? rowToAccount(rows[0]) : null;
};

/**
 * Gets accounts by item ID.
 */
export const getAccountsByItem = async (
  user: MaskedUser,
  item_id: string
): Promise<JSONAccount[]> => {
  const rows = await selectWithFilters<Record<string, unknown>>(pool, ACCOUNTS, "*", {
    user_id: user.user_id,
    filters: { [ITEM_ID]: item_id },
  });
  return rows.map(rowToAccount);
};

/**
 * Alias for getAccountsByItem.
 */
export const searchAccountsByItemId = getAccountsByItem;

/**
 * Searches accounts with optional filters.
 */
export const searchAccounts = async (
  user: MaskedUser,
  options: {
    account_id?: string;
    item_id?: string;
    institution_id?: string;
    type?: string;
  } = {}
): Promise<JSONAccount[]> => {
  const { sql, values } = buildSelectWithFilters(ACCOUNTS, "*", {
    user_id: user.user_id,
    filters: {
      [ACCOUNT_ID]: options.account_id,
      [ITEM_ID]: options.item_id,
      [INSTITUTION_ID]: options.institution_id,
      type: options.type,
    },
  });

  const result = await pool.query<Record<string, unknown>>(sql, values);
  return result.rows.map(rowToAccount);
};

/**
 * Searches accounts by IDs.
 */
export const searchAccountsById = async (
  user: MaskedUser,
  account_ids: string[]
): Promise<JSONAccount[]> => {
  if (!account_ids.length) return [];

  const placeholders = account_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query<Record<string, unknown>>(
    `SELECT * FROM ${ACCOUNTS}
     WHERE ${ACCOUNT_ID} IN (${placeholders}) AND ${USER_ID} = $1
     AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [user.user_id, ...account_ids]
  );
  return result.rows.map(rowToAccount);
};

/**
 * Upserts accounts for a user.
 */
export const upsertAccounts = async (
  user: MaskedUser,
  accounts: JSONAccount[]
): Promise<UpsertResult[]> => {
  if (!accounts.length) return [];
  const results: UpsertResult[] = [];

  for (const account of accounts) {
    const row = AccountModel.fromJSON(account, user.user_id);

    try {
      const columns = Object.keys(row);
      const values = Object.values(row);
      const placeholders = values.map((_, i) => `$${i + 1}`);

      const updateClauses = columns
        .filter((col) => col !== ACCOUNT_ID && col !== USER_ID)
        .map((col) => `${col} = EXCLUDED.${col}`);
      updateClauses.push("updated = CURRENT_TIMESTAMP");

      const query = `
        INSERT INTO ${ACCOUNTS} (${columns.join(", ")}, updated)
        VALUES (${placeholders.join(", ")}, CURRENT_TIMESTAMP)
        ON CONFLICT (${ACCOUNT_ID}) DO UPDATE SET
          ${updateClauses.join(", ")}
        WHERE ${ACCOUNTS}.${USER_ID} = $${columns.indexOf(USER_ID) + 1}
        RETURNING ${ACCOUNT_ID}
      `;

      const result = await pool.query(query, values);
      results.push(successResult(account.account_id, result.rowCount));
    } catch (error) {
      console.error(`Failed to upsert account ${account.account_id}:`, error);
      results.push(errorResult(account.account_id));
    }
  }

  return results;
};

/**
 * Updates accounts for a user.
 */
export const updateAccounts = async (
  user: MaskedUser,
  accounts: PartialAccount[]
): Promise<UpsertResult[]> => {
  if (!accounts.length) return [];
  const results: UpsertResult[] = [];

  for (const account of accounts) {
    const row = AccountModel.fromJSON(account, user.user_id);

    try {
      const updateData = { ...row };
      delete updateData.account_id;
      delete updateData.user_id;

      const query = buildUpdate(
        ACCOUNTS,
        ACCOUNT_ID,
        account.account_id,
        updateData as Record<string, unknown>,
        {
          additionalWhere: { column: USER_ID, value: user.user_id },
          returning: [ACCOUNT_ID],
        }
      );

      if (query) {
        const result = await pool.query(query.sql, query.values);
        results.push(successResult(account.account_id, result.rowCount));
      } else {
        results.push(noChangeResult(account.account_id));
      }
    } catch (error) {
      console.error(`Failed to update account ${account.account_id}:`, error);
      results.push(errorResult(account.account_id));
    }
  }

  return results;
};

/**
 * Deletes accounts with cascade.
 */
export const deleteAccounts = async (
  user: MaskedUser,
  account_ids: string[]
): Promise<{ deleted: number }> => {
  if (!account_ids.length) return { deleted: 0 };
  const { user_id } = user;

  const placeholders = account_ids.map((_, i) => `$${i + 2}`).join(", ");

  // Cascade: soft-delete transactions
  await pool.query(
    `UPDATE ${TRANSACTIONS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE ${ACCOUNT_ID} IN (${placeholders}) AND ${USER_ID} = $1`,
    [user_id, ...account_ids]
  );

  // Cascade: soft-delete investment_transactions
  await pool.query(
    `UPDATE ${INVESTMENT_TRANSACTIONS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE ${ACCOUNT_ID} IN (${placeholders}) AND ${USER_ID} = $1`,
    [user_id, ...account_ids]
  );

  // Cascade: soft-delete split_transactions
  await pool.query(
    `UPDATE ${SPLIT_TRANSACTIONS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE ${ACCOUNT_ID} IN (${placeholders}) AND ${USER_ID} = $1`,
    [user_id, ...account_ids]
  );

  // Cascade: soft-delete snapshots
  await pool.query(
    `UPDATE ${SNAPSHOTS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE ${ACCOUNT_ID} IN (${placeholders}) AND ${USER_ID} = $1`,
    [user_id, ...account_ids]
  );

  // Cascade: soft-delete holdings
  await pool.query(
    `UPDATE ${HOLDINGS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE ${ACCOUNT_ID} IN (${placeholders}) AND ${USER_ID} = $1`,
    [user_id, ...account_ids]
  );

  const result = await pool.query(
    `UPDATE ${ACCOUNTS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE ${ACCOUNT_ID} IN (${placeholders}) AND ${USER_ID} = $1
     RETURNING ${ACCOUNT_ID}`,
    [user_id, ...account_ids]
  );

  return { deleted: result.rowCount || 0 };
};

// Holding Repository Functions

/**
 * Gets all holdings for a user.
 */
export const getHoldings = async (user: MaskedUser): Promise<JSONHolding[]> => {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT * FROM ${HOLDINGS}
     WHERE ${USER_ID} = $1
     AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [user.user_id]
  );
  return result.rows.map(rowToHolding);
};

/**
 * Searches holdings by account IDs.
 */
export const searchHoldingsByAccountId = async (
  user: MaskedUser,
  account_ids: string[]
): Promise<JSONHolding[]> => {
  if (!account_ids.length) return [];

  const placeholders = account_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query<Record<string, unknown>>(
    `SELECT * FROM ${HOLDINGS}
     WHERE ${ACCOUNT_ID} IN (${placeholders}) AND ${USER_ID} = $1
     AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [user.user_id, ...account_ids]
  );
  return result.rows.map(rowToHolding);
};

/**
 * Upserts holdings for a user.
 */
export const upsertHoldings = async (
  user: MaskedUser,
  holdings: (Partial<JSONHolding> & { holding_id?: string })[]
): Promise<UpsertResult[]> => {
  if (!holdings.length) return [];
  const results: UpsertResult[] = [];

  for (const holding of holdings) {
    const row = HoldingModel.fromJSON(holding, user.user_id);
    const holding_id = row.holding_id as string;

    try {
      const columns = Object.keys(row);
      const values = Object.values(row);
      const placeholders = values.map((_, i) => `$${i + 1}`);

      const updateClauses = columns
        .filter((col) => col !== HOLDING_ID && col !== USER_ID)
        .map((col) => `${col} = EXCLUDED.${col}`);
      updateClauses.push("updated = CURRENT_TIMESTAMP");

      const query = `
        INSERT INTO ${HOLDINGS} (${columns.join(", ")}, updated)
        VALUES (${placeholders.join(", ")}, CURRENT_TIMESTAMP)
        ON CONFLICT (${HOLDING_ID}) DO UPDATE SET
          ${updateClauses.join(", ")}
        RETURNING ${HOLDING_ID}
      `;

      const result = await pool.query(query, values);
      results.push(successResult(holding_id, result.rowCount));
    } catch (error) {
      console.error(`Failed to upsert holding ${holding_id}:`, error);
      results.push(errorResult(holding_id));
    }
  }

  return results;
};

/**
 * Deletes holdings.
 */
export const deleteHoldings = async (
  user: MaskedUser,
  holding_ids: string[]
): Promise<{ deleted: number }> => {
  if (!holding_ids.length) return { deleted: 0 };

  const placeholders = holding_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `UPDATE ${HOLDINGS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE ${HOLDING_ID} IN (${placeholders}) AND ${USER_ID} = $1
     RETURNING ${HOLDING_ID}`,
    [user.user_id, ...holding_ids]
  );

  return { deleted: result.rowCount || 0 };
};

// Institution Repository Functions

/**
 * Gets an institution by ID.
 */
export const getInstitution = async (
  institution_id: string
): Promise<JSONInstitution | null> => {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT * FROM ${INSTITUTIONS} WHERE ${INSTITUTION_ID} = $1`,
    [institution_id]
  );
  return result.rows.length > 0 ? rowToInstitution(result.rows[0]) : null;
};

/**
 * Alias for getInstitution.
 */
export const searchInstitutionById = getInstitution;

/**
 * Upserts institutions.
 */
export const upsertInstitutions = async (
  institutions: Partial<JSONInstitution>[]
): Promise<UpsertResult[]> => {
  if (!institutions.length) return [];
  const results: UpsertResult[] = [];

  for (const institution of institutions) {
    if (!institution.institution_id) continue;

    const row = InstitutionModel.fromJSON(institution);

    try {
      const columns = Object.keys(row);
      const values = Object.values(row);
      const placeholders = values.map((_, i) => `$${i + 1}`);

      const updateClauses = columns
        .filter((col) => col !== INSTITUTION_ID)
        .map((col) => `${col} = EXCLUDED.${col}`);
      updateClauses.push("updated = CURRENT_TIMESTAMP");

      const query = `
        INSERT INTO ${INSTITUTIONS} (${columns.join(", ")}, updated)
        VALUES (${placeholders.join(", ")}, CURRENT_TIMESTAMP)
        ON CONFLICT (${INSTITUTION_ID}) DO UPDATE SET
          ${updateClauses.join(", ")}
        RETURNING ${INSTITUTION_ID}
      `;

      const result = await pool.query(query, values);
      results.push(successResult(institution.institution_id, result.rowCount));
    } catch (error) {
      console.error(`Failed to upsert institution ${institution.institution_id}:`, error);
      results.push(errorResult(institution.institution_id));
    }
  }

  return results;
};

// Security Repository Functions

/**
 * Gets a security by ID.
 */
export const getSecurity = async (
  security_id: string
): Promise<JSONSecurity | null> => {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT * FROM ${SECURITIES} WHERE ${SECURITY_ID} = $1`,
    [security_id]
  );
  return result.rows.length > 0 ? rowToSecurity(result.rows[0]) : null;
};

/**
 * Gets all securities for a user (via holdings).
 */
export const getSecurities = async (user: MaskedUser): Promise<JSONSecurity[]> => {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT DISTINCT s.* FROM ${SECURITIES} s
     INNER JOIN ${HOLDINGS} h ON s.${SECURITY_ID} = h.${SECURITY_ID}
     WHERE h.${USER_ID} = $1
     AND (h.is_deleted IS NULL OR h.is_deleted = FALSE)`,
    [user.user_id]
  );
  return result.rows.map(rowToSecurity);
};

/**
 * Searches securities by various criteria.
 */
export const searchSecurities = async (
  options: string[] | { security_id?: string; ticker_symbol?: string; security_ids?: string[] }
): Promise<JSONSecurity[]> => {
  // Handle array of security IDs
  if (Array.isArray(options)) {
    if (!options.length) return [];
    const { sql, values } = buildSelectWithFilters(SECURITIES, "*", {
      inFilters: { [SECURITY_ID]: options },
      excludeDeleted: false, // Securities don't have soft delete
    });
    const result = await pool.query<Record<string, unknown>>(sql, values);
    return result.rows.map(rowToSecurity);
  }

  // Handle options object
  if (!options.security_id && !options.ticker_symbol && !options.security_ids?.length) {
    return [];
  }

  const { sql, values } = buildSelectWithFilters(SECURITIES, "*", {
    filters: {
      [SECURITY_ID]: options.security_id,
      ticker_symbol: options.ticker_symbol,
    },
    inFilters: options.security_ids?.length
      ? { [SECURITY_ID]: options.security_ids }
      : undefined,
    excludeDeleted: false, // Securities don't have soft delete
  });

  const result = await pool.query<Record<string, unknown>>(sql, values);
  return result.rows.map(rowToSecurity);
};

/**
 * Upserts securities.
 */
export const upsertSecurities = async (
  securities: JSONSecurity[]
): Promise<UpsertResult[]> => {
  if (!securities.length) return [];
  const results: UpsertResult[] = [];

  for (const security of securities) {
    if (!security.security_id) continue;

    const row = SecurityModel.fromJSON(security);

    try {
      const columns = Object.keys(row);
      const values = Object.values(row);
      const placeholders = values.map((_, i) => `$${i + 1}`);

      const updateClauses = columns
        .filter((col) => col !== SECURITY_ID)
        .map((col) => `${col} = EXCLUDED.${col}`);
      updateClauses.push("updated = CURRENT_TIMESTAMP");

      const query = `
        INSERT INTO ${SECURITIES} (${columns.join(", ")}, updated)
        VALUES (${placeholders.join(", ")}, CURRENT_TIMESTAMP)
        ON CONFLICT (${SECURITY_ID}) DO UPDATE SET
          ${updateClauses.join(", ")}
        RETURNING ${SECURITY_ID}
      `;

      const result = await pool.query(query, values);
      results.push(successResult(security.security_id, result.rowCount));
    } catch (error) {
      console.error(`Failed to upsert security ${security.security_id}:`, error);
      results.push(errorResult(security.security_id));
    }
  }

  return results;
};
