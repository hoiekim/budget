import { JSONAccount, JSONHolding, JSONInstitution, JSONSecurity } from "common";
import { pool } from "./client";
import { MaskedUser } from "./users";
import { buildUpdateQuery, buildUpsertQuery } from "./utils";

export type PartialAccount = { account_id: string } & Partial<JSONAccount>;

// Column definitions for accounts table
const ACCOUNT_COLUMNS = [
  "account_id", "user_id", "item_id", "institution_id",
  "balances_available", "balances_current", "balances_limit",
  "balances_iso_currency_code", "balances_unofficial_currency_code",
  "mask", "name", "official_name", "type", "subtype", "custom_name", "hide",
  "label_budget_id", "graph_options_use_snapshots", "graph_options_use_transactions",
  "updated", "is_deleted"
];

/**
 * Converts an ES-style account object to flat Postgres columns.
 */
function accountToRow(account: PartialAccount): Record<string, any> {
  const row: Record<string, any> = {};
  
  // Direct mappings
  if (account.account_id !== undefined) row.account_id = account.account_id;
  if (account.item_id !== undefined) row.item_id = account.item_id;
  if (account.institution_id !== undefined) row.institution_id = account.institution_id;
  if (account.mask !== undefined) row.mask = account.mask;
  if (account.name !== undefined) row.name = account.name;
  if (account.official_name !== undefined) row.official_name = account.official_name;
  if (account.type !== undefined) row.type = account.type;
  if (account.subtype !== undefined) row.subtype = account.subtype;
  if (account.custom_name !== undefined) row.custom_name = account.custom_name;
  if (account.hide !== undefined) row.hide = account.hide;
  
  // Flatten balances
  if (account.balances) {
    if (account.balances.available !== undefined) row.balances_available = account.balances.available;
    if (account.balances.current !== undefined) row.balances_current = account.balances.current;
    if (account.balances.limit !== undefined) row.balances_limit = account.balances.limit;
    if (account.balances.iso_currency_code !== undefined) row.balances_iso_currency_code = account.balances.iso_currency_code;
    if (account.balances.unofficial_currency_code !== undefined) row.balances_unofficial_currency_code = account.balances.unofficial_currency_code;
  }
  
  // Flatten label
  if (account.label) {
    if (account.label.budget_id !== undefined) row.label_budget_id = account.label.budget_id;
  }
  
  // Flatten graphOptions
  if (account.graphOptions) {
    if (account.graphOptions.useSnapshots !== undefined) row.graph_options_use_snapshots = account.graphOptions.useSnapshots;
    if (account.graphOptions.useTransactions !== undefined) row.graph_options_use_transactions = account.graphOptions.useTransactions;
  }
  
  return row;
}

/**
 * Converts a Postgres row to ES-style account object.
 */
function rowToAccount(row: Record<string, any>): JSONAccount {
  return {
    account_id: row.account_id,
    user_id: row.user_id,
    item_id: row.item_id,
    institution_id: row.institution_id,
    mask: row.mask,
    name: row.name,
    official_name: row.official_name,
    type: row.type,
    subtype: row.subtype,
    custom_name: row.custom_name,
    hide: row.hide,
    balances: {
      available: row.balances_available,
      current: row.balances_current,
      limit: row.balances_limit,
      iso_currency_code: row.balances_iso_currency_code,
      unofficial_currency_code: row.balances_unofficial_currency_code,
    },
    label: {
      budget_id: row.label_budget_id,
    },
    graphOptions: {
      useSnapshots: row.graph_options_use_snapshots,
      useTransactions: row.graph_options_use_transactions,
    },
  } as JSONAccount;
}

/**
 * Updates or inserts accounts associated with given user.
 * Uses dynamic UPDATE to only update defined fields.
 * @param user
 * @param accounts
 * @param upsert
 * @returns A promise to be an array of result objects
 */
export const upsertAccounts = async (
  user: MaskedUser,
  accounts: PartialAccount[],
  upsert: boolean = true
) => {
  if (!accounts.length) return [];
  const { user_id } = user;
  const results: { update: { _id: string }; status: number }[] = [];

  for (const account of accounts) {
    const row = accountToRow(account);
    row.user_id = user_id;
    
    try {
      if (upsert) {
        // Build dynamic INSERT ... ON CONFLICT DO UPDATE
        const columns = Object.keys(row);
        const values = Object.values(row);
        const placeholders = values.map((_, i) => `$${i + 1}`);
        
        // Build SET clause for conflict - only update non-key columns
        const updateClauses = columns
          .filter(col => col !== "account_id" && col !== "user_id")
          .map(col => `${col} = EXCLUDED.${col}`);
        updateClauses.push("updated = CURRENT_TIMESTAMP");
        
        const query = `
          INSERT INTO accounts (${columns.join(", ")}, updated)
          VALUES (${placeholders.join(", ")}, CURRENT_TIMESTAMP)
          ON CONFLICT (account_id) DO UPDATE SET
            ${updateClauses.join(", ")}
          WHERE accounts.user_id = $${columns.indexOf("user_id") + 1}
          RETURNING account_id
        `;
        
        const result = await pool.query(query, values);
        results.push({
          update: { _id: account.account_id },
          status: result.rowCount ? 200 : 404,
        });
      } else {
        // Update only - build dynamic UPDATE query
        const updateData = { ...row };
        delete updateData.account_id;
        delete updateData.user_id;
        
        const queryResult = buildUpdateQuery(
          "accounts",
          "account_id",
          account.account_id,
          updateData,
          { additionalWhere: { column: "user_id", value: user_id }, returning: ["account_id"] }
        );
        
        if (queryResult) {
          const result = await pool.query(queryResult.query, queryResult.values);
          results.push({
            update: { _id: account.account_id },
            status: result.rowCount ? 200 : 404,
          });
        } else {
          results.push({
            update: { _id: account.account_id },
            status: 304, // Not modified
          });
        }
      }
    } catch (error: any) {
      console.error(`Failed to upsert account ${account.account_id}:`, error.message);
      results.push({
        update: { _id: account.account_id },
        status: 500,
      });
    }
  }

  return results;
};

/**
 * Retrieves all accounts for a user.
 */
export const getAccounts = async (user: MaskedUser): Promise<JSONAccount[]> => {
  const { user_id } = user;
  const result = await pool.query(
    `SELECT * FROM accounts WHERE user_id = $1 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [user_id]
  );
  return result.rows.map(rowToAccount);
};

/**
 * Retrieves a single account by ID.
 */
export const getAccount = async (
  user: MaskedUser,
  account_id: string
): Promise<JSONAccount | null> => {
  const { user_id } = user;
  const result = await pool.query(
    `SELECT * FROM accounts WHERE account_id = $1 AND user_id = $2 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [account_id, user_id]
  );
  return result.rows.length > 0 ? rowToAccount(result.rows[0]) : null;
};

/**
 * Deletes accounts (soft delete).
 */
export const deleteAccounts = async (
  user: MaskedUser,
  account_ids: string[]
): Promise<{ deleted: number }> => {
  if (!account_ids.length) return { deleted: 0 };
  const { user_id } = user;
  
  const placeholders = account_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `UPDATE accounts SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP 
     WHERE account_id IN (${placeholders}) AND user_id = $1
     RETURNING account_id`,
    [user_id, ...account_ids]
  );
  
  return { deleted: result.rowCount || 0 };
};

/**
 * Gets accounts by item_id.
 */
export const getAccountsByItem = async (
  user: MaskedUser,
  item_id: string
): Promise<JSONAccount[]> => {
  const { user_id } = user;
  const result = await pool.query(
    `SELECT * FROM accounts WHERE item_id = $1 AND user_id = $2 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [item_id, user_id]
  );
  return result.rows.map(rowToAccount);
};

// =====================================
// Holdings operations
// =====================================

function holdingToRow(holding: Partial<JSONHolding>): Record<string, any> {
  const row: Record<string, any> = {};
  
  if (holding.account_id !== undefined) row.account_id = holding.account_id;
  if (holding.security_id !== undefined) row.security_id = holding.security_id;
  if (holding.institution_price !== undefined) row.institution_price = holding.institution_price;
  if (holding.institution_price_as_of !== undefined) row.institution_price_as_of = holding.institution_price_as_of;
  if (holding.institution_value !== undefined) row.institution_value = holding.institution_value;
  if (holding.cost_basis !== undefined) row.cost_basis = holding.cost_basis;
  if (holding.quantity !== undefined) row.quantity = holding.quantity;
  if (holding.iso_currency_code !== undefined) row.iso_currency_code = holding.iso_currency_code;
  if (holding.unofficial_currency_code !== undefined) row.unofficial_currency_code = holding.unofficial_currency_code;
  
  return row;
}

function rowToHolding(row: Record<string, any>): JSONHolding {
  return {
    holding_id: row.holding_id,
    user_id: row.user_id,
    account_id: row.account_id,
    security_id: row.security_id,
    institution_price: row.institution_price,
    institution_price_as_of: row.institution_price_as_of,
    institution_value: row.institution_value,
    cost_basis: row.cost_basis,
    quantity: row.quantity,
    iso_currency_code: row.iso_currency_code,
    unofficial_currency_code: row.unofficial_currency_code,
  } as JSONHolding;
}

export const upsertHoldings = async (
  user: MaskedUser,
  holdings: (Partial<JSONHolding> & { holding_id?: string })[]
) => {
  if (!holdings.length) return [];
  const { user_id } = user;
  const results: { update: { _id: string }; status: number }[] = [];

  for (const holding of holdings) {
    const holding_id = holding.holding_id || `${holding.account_id}-${holding.security_id}`;
    const row = holdingToRow(holding);
    row.holding_id = holding_id;
    row.user_id = user_id;
    
    try {
      const columns = Object.keys(row);
      const values = Object.values(row);
      const placeholders = values.map((_, i) => `$${i + 1}`);
      
      const updateClauses = columns
        .filter(col => col !== "holding_id" && col !== "user_id")
        .map(col => `${col} = EXCLUDED.${col}`);
      updateClauses.push("updated = CURRENT_TIMESTAMP");
      
      const query = `
        INSERT INTO holdings (${columns.join(", ")}, updated)
        VALUES (${placeholders.join(", ")}, CURRENT_TIMESTAMP)
        ON CONFLICT (holding_id) DO UPDATE SET
          ${updateClauses.join(", ")}
        RETURNING holding_id
      `;
      
      const result = await pool.query(query, values);
      results.push({
        update: { _id: holding_id },
        status: result.rowCount ? 200 : 404,
      });
    } catch (error: any) {
      console.error(`Failed to upsert holding ${holding_id}:`, error.message);
      results.push({
        update: { _id: holding_id },
        status: 500,
      });
    }
  }

  return results;
};

export const getHoldings = async (user: MaskedUser): Promise<JSONHolding[]> => {
  const { user_id } = user;
  const result = await pool.query(
    `SELECT * FROM holdings WHERE user_id = $1 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [user_id]
  );
  return result.rows.map(rowToHolding);
};

/**
 * Deletes holdings (soft delete).
 */
export const deleteHoldings = async (
  user: MaskedUser,
  holding_ids: string[]
): Promise<{ deleted: number }> => {
  if (!holding_ids.length) return { deleted: 0 };
  const { user_id } = user;
  
  const placeholders = holding_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `UPDATE holdings SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP 
     WHERE holding_id IN (${placeholders}) AND user_id = $1
     RETURNING holding_id`,
    [user_id, ...holding_ids]
  );
  
  return { deleted: result.rowCount || 0 };
};

// =====================================
// Institutions operations
// =====================================

function institutionToRow(institution: Partial<JSONInstitution>): Record<string, any> {
  const row: Record<string, any> = {};
  
  if (institution.institution_id !== undefined) row.institution_id = institution.institution_id;
  if (institution.name !== undefined) row.name = institution.name;
  if (institution.products !== undefined) row.products = institution.products;
  if (institution.country_codes !== undefined) row.country_codes = institution.country_codes;
  if (institution.url !== undefined) row.url = institution.url;
  if (institution.primary_color !== undefined) row.primary_color = institution.primary_color;
  if (institution.logo !== undefined) row.logo = institution.logo;
  if (institution.routing_numbers !== undefined) row.routing_numbers = institution.routing_numbers;
  if (institution.oauth !== undefined) row.oauth = institution.oauth;
  if (institution.status !== undefined) row.status = JSON.stringify(institution.status);
  
  return row;
}

function rowToInstitution(row: Record<string, any>): JSONInstitution {
  return {
    institution_id: row.institution_id,
    name: row.name,
    products: row.products,
    country_codes: row.country_codes,
    url: row.url,
    primary_color: row.primary_color,
    logo: row.logo,
    routing_numbers: row.routing_numbers,
    oauth: row.oauth,
    status: row.status ? JSON.parse(row.status) : undefined,
  } as JSONInstitution;
}

export const upsertInstitutions = async (institutions: Partial<JSONInstitution>[]) => {
  if (!institutions.length) return [];
  const results: { update: { _id: string }; status: number }[] = [];

  for (const institution of institutions) {
    if (!institution.institution_id) continue;
    
    const row = institutionToRow(institution);
    
    try {
      const columns = Object.keys(row);
      const values = Object.values(row);
      const placeholders = values.map((_, i) => `$${i + 1}`);
      
      const updateClauses = columns
        .filter(col => col !== "institution_id")
        .map(col => `${col} = EXCLUDED.${col}`);
      updateClauses.push("updated = CURRENT_TIMESTAMP");
      
      const query = `
        INSERT INTO institutions (${columns.join(", ")}, updated)
        VALUES (${placeholders.join(", ")}, CURRENT_TIMESTAMP)
        ON CONFLICT (institution_id) DO UPDATE SET
          ${updateClauses.join(", ")}
        RETURNING institution_id
      `;
      
      const result = await pool.query(query, values);
      results.push({
        update: { _id: institution.institution_id },
        status: result.rowCount ? 200 : 404,
      });
    } catch (error: any) {
      console.error(`Failed to upsert institution ${institution.institution_id}:`, error.message);
      results.push({
        update: { _id: institution.institution_id },
        status: 500,
      });
    }
  }

  return results;
};

export const getInstitution = async (institution_id: string): Promise<JSONInstitution | null> => {
  const result = await pool.query(
    `SELECT * FROM institutions WHERE institution_id = $1`,
    [institution_id]
  );
  return result.rows.length > 0 ? rowToInstitution(result.rows[0]) : null;
};

// =====================================
// Securities operations
// =====================================

function securityToRow(security: Partial<JSONSecurity>): Record<string, any> {
  const row: Record<string, any> = {};
  
  if (security.security_id !== undefined) row.security_id = security.security_id;
  if (security.isin !== undefined) row.isin = security.isin;
  if (security.cusip !== undefined) row.cusip = security.cusip;
  if (security.sedol !== undefined) row.sedol = security.sedol;
  if (security.institution_security_id !== undefined) row.institution_security_id = security.institution_security_id;
  if (security.institution_id !== undefined) row.institution_id = security.institution_id;
  if (security.proxy_security_id !== undefined) row.proxy_security_id = security.proxy_security_id;
  if (security.name !== undefined) row.name = security.name;
  if (security.ticker_symbol !== undefined) row.ticker_symbol = security.ticker_symbol;
  if (security.is_cash_equivalent !== undefined) row.is_cash_equivalent = security.is_cash_equivalent;
  if (security.type !== undefined) row.type = security.type;
  if (security.close_price !== undefined) row.close_price = security.close_price;
  if (security.close_price_as_of !== undefined) row.close_price_as_of = security.close_price_as_of;
  if (security.iso_currency_code !== undefined) row.iso_currency_code = security.iso_currency_code;
  if (security.unofficial_currency_code !== undefined) row.unofficial_currency_code = security.unofficial_currency_code;
  
  return row;
}

function rowToSecurity(row: Record<string, any>): JSONSecurity {
  return {
    security_id: row.security_id,
    isin: row.isin,
    cusip: row.cusip,
    sedol: row.sedol,
    institution_security_id: row.institution_security_id,
    institution_id: row.institution_id,
    proxy_security_id: row.proxy_security_id,
    name: row.name,
    ticker_symbol: row.ticker_symbol,
    is_cash_equivalent: row.is_cash_equivalent,
    type: row.type,
    close_price: row.close_price,
    close_price_as_of: row.close_price_as_of,
    iso_currency_code: row.iso_currency_code,
    unofficial_currency_code: row.unofficial_currency_code,
  } as JSONSecurity;
}

export const upsertSecurities = async (securities: Partial<JSONSecurity>[]) => {
  if (!securities.length) return [];
  const results: { update: { _id: string }; status: number }[] = [];

  for (const security of securities) {
    if (!security.security_id) continue;
    
    const row = securityToRow(security);
    
    try {
      const columns = Object.keys(row);
      const values = Object.values(row);
      const placeholders = values.map((_, i) => `$${i + 1}`);
      
      const updateClauses = columns
        .filter(col => col !== "security_id")
        .map(col => `${col} = EXCLUDED.${col}`);
      updateClauses.push("updated = CURRENT_TIMESTAMP");
      
      const query = `
        INSERT INTO securities (${columns.join(", ")}, updated)
        VALUES (${placeholders.join(", ")}, CURRENT_TIMESTAMP)
        ON CONFLICT (security_id) DO UPDATE SET
          ${updateClauses.join(", ")}
        RETURNING security_id
      `;
      
      const result = await pool.query(query, values);
      results.push({
        update: { _id: security.security_id },
        status: result.rowCount ? 200 : 404,
      });
    } catch (error: any) {
      console.error(`Failed to upsert security ${security.security_id}:`, error.message);
      results.push({
        update: { _id: security.security_id },
        status: 500,
      });
    }
  }

  return results;
};

export const getSecurities = async (user: MaskedUser): Promise<JSONSecurity[]> => {
  // Securities are not user-specific, but we filter by holdings
  const { user_id } = user;
  const result = await pool.query(
    `SELECT DISTINCT s.* FROM securities s
     INNER JOIN holdings h ON s.security_id = h.security_id
     WHERE h.user_id = $1 AND (h.is_deleted IS NULL OR h.is_deleted = FALSE)`,
    [user_id]
  );
  return result.rows.map(rowToSecurity);
};

export const getSecurity = async (security_id: string): Promise<JSONSecurity | null> => {
  const result = await pool.query(
    `SELECT * FROM securities WHERE security_id = $1`,
    [security_id]
  );
  return result.rows.length > 0 ? rowToSecurity(result.rows[0]) : null;
};

/**
 * Searches securities by IDs.
 */
export const searchSecurities = async (security_ids: string[]): Promise<JSONSecurity[]> => {
  if (!security_ids.length) return [];
  
  const placeholders = security_ids.map((_, i) => `$${i + 1}`).join(", ");
  const result = await pool.query(
    `SELECT * FROM securities WHERE security_id IN (${placeholders})`,
    security_ids
  );
  return result.rows.map(rowToSecurity);
};

/**
 * Searches accounts by item_id (alias for getAccountsByItem).
 */
export const searchAccountsByItemId = async (
  user: MaskedUser,
  item_id: string
): Promise<JSONAccount[]> => {
  return getAccountsByItem(user, item_id);
};

/**
 * Searches holdings by account IDs.
 */
export const searchHoldingsByAccountId = async (
  user: MaskedUser,
  account_ids: string[]
): Promise<JSONHolding[]> => {
  if (!account_ids.length) return [];
  const { user_id } = user;
  
  const placeholders = account_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `SELECT * FROM holdings 
     WHERE account_id IN (${placeholders}) AND user_id = $1 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [user_id, ...account_ids]
  );
  return result.rows.map(rowToHolding);
};
