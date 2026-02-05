import { JSONAccount, JSONHolding, JSONInstitution, JSONSecurity } from "common";
import { pool } from "./client";
import { MaskedUser } from "./users";
import { buildUpdateQuery, buildUpsertQuery } from "./utils";

export type PartialAccount = { account_id: string } & Partial<JSONAccount>;

/**
 * Converts an account object to flat Postgres columns + raw JSONB.
 * Keeps indexed/user-edited columns; stores full provider object in raw.
 */
function accountToRow(account: PartialAccount): Record<string, any> {
  const row: Record<string, any> = {};
  
  if (account.account_id !== undefined) row.account_id = account.account_id;
  if (account.item_id !== undefined) row.item_id = account.item_id;
  if (account.institution_id !== undefined) row.institution_id = account.institution_id;
  if (account.name !== undefined) row.name = account.name;
  if (account.type !== undefined) row.type = account.type;
  if (account.subtype !== undefined) row.subtype = account.subtype;
  
  // User-edited fields
  if (account.custom_name !== undefined) row.custom_name = account.custom_name;
  if (account.hide !== undefined) row.hide = account.hide;
  if (account.label) {
    if (account.label.budget_id !== undefined) row.label_budget_id = account.label.budget_id;
  }
  if (account.graphOptions) {
    if (account.graphOptions.useSnapshots !== undefined) row.graph_options_use_snapshots = account.graphOptions.useSnapshots;
    if (account.graphOptions.useTransactions !== undefined) row.graph_options_use_transactions = account.graphOptions.useTransactions;
  }
  
  // Store full provider object in raw (excluding user-edited fields)
  const { custom_name, hide, label, graphOptions, ...providerData } = account;
  row.raw = JSON.stringify(providerData);
  
  return row;
}

/**
 * Converts a Postgres row to account object.
 * Merges raw JSONB with user-edited column values.
 */
function rowToAccount(row: Record<string, any>): JSONAccount {
  const raw = row.raw ? (typeof row.raw === 'string' ? JSON.parse(row.raw) : row.raw) : {};
  
  return {
    ...raw,
    account_id: row.account_id,
    user_id: row.user_id,
    item_id: row.item_id ?? raw.item_id,
    institution_id: row.institution_id ?? raw.institution_id,
    name: row.name ?? raw.name,
    type: row.type ?? raw.type,
    subtype: row.subtype ?? raw.subtype,
    // Fields from raw
    mask: raw.mask ?? null,
    official_name: raw.official_name ?? null,
    balances: raw.balances || {
      available: null, current: null, limit: null,
      iso_currency_code: null, unofficial_currency_code: null,
    },
    // User-edited fields from columns (always override raw)
    custom_name: row.custom_name ?? "",
    hide: row.hide ?? false,
    label: {
      budget_id: row.label_budget_id,
    },
    graphOptions: {
      useSnapshots: row.graph_options_use_snapshots ?? true,
      useTransactions: row.graph_options_use_transactions ?? true,
    },
  } as JSONAccount;
}

/**
 * Updates or inserts accounts associated with given user.
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
        const columns = Object.keys(row);
        const values = Object.values(row);
        const placeholders = values.map((_, i) => `$${i + 1}`);
        
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
            status: 304,
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

export const getAccounts = async (user: MaskedUser): Promise<JSONAccount[]> => {
  const { user_id } = user;
  const result = await pool.query(
    `SELECT * FROM accounts WHERE user_id = $1 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [user_id]
  );
  return result.rows.map(rowToAccount);
};

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
 * Cascades: soft-deletes child transactions, investment_transactions, split_transactions, snapshots, holdings.
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
    `UPDATE transactions SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE account_id IN (${placeholders}) AND user_id = $1`,
    [user_id, ...account_ids]
  );

  // Cascade: soft-delete investment_transactions
  await pool.query(
    `UPDATE investment_transactions SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE account_id IN (${placeholders}) AND user_id = $1`,
    [user_id, ...account_ids]
  );

  // Cascade: soft-delete split_transactions
  await pool.query(
    `UPDATE split_transactions SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE account_id IN (${placeholders}) AND user_id = $1`,
    [user_id, ...account_ids]
  );

  // Cascade: soft-delete snapshots
  await pool.query(
    `UPDATE snapshots SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE account_id IN (${placeholders}) AND user_id = $1`,
    [user_id, ...account_ids]
  );

  // Cascade: soft-delete holdings
  await pool.query(
    `UPDATE holdings SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE account_id IN (${placeholders}) AND user_id = $1`,
    [user_id, ...account_ids]
  );

  const result = await pool.query(
    `UPDATE accounts SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP 
     WHERE account_id IN (${placeholders}) AND user_id = $1
     RETURNING account_id`,
    [user_id, ...account_ids]
  );
  
  return { deleted: result.rowCount || 0 };
};

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
  if (holding.institution_value !== undefined) row.institution_value = holding.institution_value;
  if (holding.cost_basis !== undefined) row.cost_basis = holding.cost_basis;
  if (holding.quantity !== undefined) row.quantity = holding.quantity;
  if (holding.iso_currency_code !== undefined) row.iso_currency_code = holding.iso_currency_code;

  // Store full provider object in raw
  row.raw = JSON.stringify(holding);
  
  return row;
}

function rowToHolding(row: Record<string, any>): JSONHolding {
  const raw = row.raw ? (typeof row.raw === 'string' ? JSON.parse(row.raw) : row.raw) : {};
  
  return {
    ...raw,
    holding_id: row.holding_id,
    user_id: row.user_id,
    account_id: row.account_id ?? raw.account_id,
    security_id: row.security_id ?? raw.security_id,
    institution_price: row.institution_price != null ? Number(row.institution_price) : (raw.institution_price ?? null),
    institution_value: row.institution_value != null ? Number(row.institution_value) : (raw.institution_value ?? null),
    cost_basis: row.cost_basis != null ? Number(row.cost_basis) : (raw.cost_basis ?? null),
    quantity: row.quantity != null ? Number(row.quantity) : (raw.quantity ?? null),
    iso_currency_code: row.iso_currency_code ?? raw.iso_currency_code,
    // Fields from raw only
    institution_price_as_of: raw.institution_price_as_of,
    unofficial_currency_code: raw.unofficial_currency_code,
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

  // Store full provider object in raw
  row.raw = JSON.stringify(institution);
  
  return row;
}

function rowToInstitution(row: Record<string, any>): JSONInstitution {
  const raw = row.raw ? (typeof row.raw === 'string' ? JSON.parse(row.raw) : row.raw) : {};
  
  return {
    ...raw,
    institution_id: row.institution_id,
    name: row.name ?? raw.name,
    products: raw.products,
    country_codes: raw.country_codes,
    url: raw.url,
    primary_color: raw.primary_color,
    logo: raw.logo,
    routing_numbers: raw.routing_numbers,
    oauth: raw.oauth,
    status: raw.status,
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
  if (security.name !== undefined) row.name = security.name;
  if (security.ticker_symbol !== undefined) row.ticker_symbol = security.ticker_symbol;
  if (security.type !== undefined) row.type = security.type;
  if (security.close_price !== undefined) row.close_price = security.close_price;
  if (security.close_price_as_of !== undefined) row.close_price_as_of = security.close_price_as_of;
  if (security.iso_currency_code !== undefined) row.iso_currency_code = security.iso_currency_code;
  if (security.isin !== undefined) row.isin = security.isin;
  if (security.cusip !== undefined) row.cusip = security.cusip;

  // Store full provider object in raw
  row.raw = JSON.stringify(security);
  
  return row;
}

function rowToSecurity(row: Record<string, any>): JSONSecurity {
  const raw = row.raw ? (typeof row.raw === 'string' ? JSON.parse(row.raw) : row.raw) : {};
  
  return {
    ...raw,
    security_id: row.security_id,
    name: row.name ?? raw.name,
    ticker_symbol: row.ticker_symbol ?? raw.ticker_symbol,
    type: row.type ?? raw.type,
    close_price: row.close_price != null ? Number(row.close_price) : (raw.close_price ?? null),
    close_price_as_of: row.close_price_as_of ?? raw.close_price_as_of,
    iso_currency_code: row.iso_currency_code ?? raw.iso_currency_code,
    isin: row.isin ?? raw.isin,
    cusip: row.cusip ?? raw.cusip,
    // Remaining fields from raw
    sedol: raw.sedol,
    institution_security_id: raw.institution_security_id,
    institution_id: raw.institution_id,
    proxy_security_id: raw.proxy_security_id,
    is_cash_equivalent: raw.is_cash_equivalent,
    unofficial_currency_code: raw.unofficial_currency_code,
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

export const searchSecurities = async (
  options: string[] | { security_id?: string; ticker_symbol?: string; security_ids?: string[] }
): Promise<JSONSecurity[]> => {
  if (Array.isArray(options)) {
    if (!options.length) return [];
    const placeholders = options.map((_, i) => `$${i + 1}`).join(", ");
    const result = await pool.query(
      `SELECT * FROM securities WHERE security_id IN (${placeholders})`,
      options
    );
    return result.rows.map(rowToSecurity);
  }
  
  const conditions: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;
  
  if (options.security_id) {
    conditions.push(`security_id = $${paramIndex}`);
    values.push(options.security_id);
    paramIndex++;
  }
  
  if (options.ticker_symbol) {
    conditions.push(`ticker_symbol = $${paramIndex}`);
    values.push(options.ticker_symbol);
    paramIndex++;
  }
  
  if (options.security_ids && options.security_ids.length > 0) {
    const placeholders = options.security_ids.map((_, i) => `$${paramIndex + i}`).join(", ");
    conditions.push(`security_id IN (${placeholders})`);
    values.push(...options.security_ids);
  }
  
  if (!conditions.length) return [];
  
  const result = await pool.query(
    `SELECT * FROM securities WHERE ${conditions.join(" AND ")}`,
    values
  );
  return result.rows.map(rowToSecurity);
};

export const searchAccountsByItemId = async (
  user: MaskedUser,
  item_id: string
): Promise<JSONAccount[]> => {
  return getAccountsByItem(user, item_id);
};

export const searchAccounts = async (
  user: MaskedUser,
  options: {
    account_id?: string;
    item_id?: string;
    institution_id?: string;
    type?: string;
  } = {}
): Promise<JSONAccount[]> => {
  const { user_id } = user;
  const conditions: string[] = ["user_id = $1", "(is_deleted IS NULL OR is_deleted = FALSE)"];
  const values: any[] = [user_id];
  let paramIndex = 2;

  if (options.account_id) {
    conditions.push(`account_id = $${paramIndex}`);
    values.push(options.account_id);
    paramIndex++;
  }

  if (options.item_id) {
    conditions.push(`item_id = $${paramIndex}`);
    values.push(options.item_id);
    paramIndex++;
  }

  if (options.institution_id) {
    conditions.push(`institution_id = $${paramIndex}`);
    values.push(options.institution_id);
    paramIndex++;
  }

  if (options.type) {
    conditions.push(`type = $${paramIndex}`);
    values.push(options.type);
    paramIndex++;
  }

  const result = await pool.query(
    `SELECT * FROM accounts WHERE ${conditions.join(" AND ")}`,
    values
  );
  return result.rows.map(rowToAccount);
};

export const searchAccountsById = async (
  user: MaskedUser,
  account_ids: string[]
): Promise<JSONAccount[]> => {
  if (!account_ids.length) return [];
  const { user_id } = user;
  
  const placeholders = account_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `SELECT * FROM accounts 
     WHERE account_id IN (${placeholders}) AND user_id = $1 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [user_id, ...account_ids]
  );
  return result.rows.map(rowToAccount);
};

export const searchInstitutionById = async (
  institution_id: string
): Promise<JSONInstitution | null> => {
  return getInstitution(institution_id);
};

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
