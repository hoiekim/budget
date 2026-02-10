import { isUndefined, JSONAccount, JSONHolding, JSONInstitution, JSONSecurity } from "common";
import { pool } from "./client";
import { MaskedUser } from "./users";
import { buildUpdateQuery } from "./utils";
import { AccountSubtype, AccountType } from "plaid";

export type PartialAccount = { account_id: string } & Partial<JSONAccount>;

// Database row interfaces
interface AccountRow {
  account_id: string;
  user_id: string;
  item_id: string;
  institution_id: string;
  name?: string | null;
  type?: string | null;
  subtype?: string | null;
  balances_available?: string | number | null;
  balances_current?: string | number | null;
  balances_limit?: string | number | null;
  balances_iso_currency_code?: string | null;
  custom_name?: string | null;
  hide?: boolean | null;
  label_budget_id?: string | null;
  graph_options_use_snapshots?: boolean | null;
  graph_options_use_transactions?: boolean | null;
  raw?: any;
  updated?: Date | null;
  is_deleted?: boolean | null;
}

interface HoldingRow {
  holding_id: string;
  user_id: string;
  account_id: string;
  security_id: string;
  institution_price?: string | number | null;
  institution_price_as_of?: string | null;
  institution_value?: string | number | null;
  cost_basis?: string | number | null;
  quantity?: string | number | null;
  iso_currency_code?: string | null;
  raw?: any;
  updated?: Date | null;
  is_deleted?: boolean | null;
}

interface InstitutionRow {
  institution_id: string;
  name?: string | null;
  raw?: any;
  updated?: Date | null;
}

interface SecurityRow {
  security_id: string;
  name?: string | null;
  ticker_symbol?: string | null;
  type?: string | null;
  close_price?: string | number | null;
  close_price_as_of?: string | null;
  iso_currency_code?: string | null;
  isin?: string | null;
  cusip?: string | null;
  raw?: any;
  updated?: Date | null;
}

/**
 * Converts an account object to flat Postgres columns + raw JSONB.
 * Keeps indexed/user-edited columns; stores full provider object in raw.
 */
function accountToRow(account: PartialAccount): Partial<AccountRow> {
  const row: Partial<AccountRow> = {};

  if (!isUndefined(account.account_id)) row.account_id = account.account_id;
  if (!isUndefined(account.item_id)) row.item_id = account.item_id;
  if (!isUndefined(account.institution_id)) row.institution_id = account.institution_id;
  if (!isUndefined(account.name)) row.name = account.name;
  if (!isUndefined(account.type)) row.type = account.type;
  if (!isUndefined(account.subtype)) row.subtype = account.subtype;

  // User-edited fields
  if (!isUndefined(account.custom_name)) row.custom_name = account.custom_name;
  if (!isUndefined(account.hide)) row.hide = account.hide;
  if (account.label) {
    if (!isUndefined(account.label.budget_id)) row.label_budget_id = account.label.budget_id;
  }
  if (account.balances) {
    if (!isUndefined(account.balances.available))
      row.balances_available = account.balances.available;
    if (!isUndefined(account.balances.current)) row.balances_current = account.balances.current;
    if (!isUndefined(account.balances.limit)) row.balances_limit = account.balances.limit;
    if (!isUndefined(account.balances.iso_currency_code))
      row.balances_iso_currency_code = account.balances.iso_currency_code;
  }
  if (account.graphOptions) {
    if (!isUndefined(account.graphOptions.useSnapshots))
      row.graph_options_use_snapshots = account.graphOptions.useSnapshots;
    if (!isUndefined(account.graphOptions.useTransactions))
      row.graph_options_use_transactions = account.graphOptions.useTransactions;
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
function rowToAccount(row: AccountRow): JSONAccount {
  return {
    account_id: row.account_id,
    item_id: row.item_id,
    institution_id: row.institution_id,
    name: row.name || "Unknown",
    type: (row.type as AccountType) || AccountType.Other,
    subtype: (row.subtype as AccountSubtype) || AccountSubtype.Other,
    // Fields from raw
    mask: null,
    official_name: null,
    balances: {
      available: row.balances_available ? Number(row.balances_available) : 0,
      current: row.balances_current ? Number(row.balances_current) : 0,
      limit: row.balances_limit ? Number(row.balances_limit) : 0,
      iso_currency_code: row.balances_iso_currency_code || "USD",
      unofficial_currency_code: null,
    },
    // User-edited fields from columns (always override raw)
    custom_name: row.custom_name || "",
    hide: !!row.hide,
    label: {
      budget_id: row.label_budget_id,
    },
    graphOptions: {
      useSnapshots:
        typeof row.graph_options_use_snapshots === "boolean"
          ? row.graph_options_use_snapshots
          : true,
      useTransactions:
        typeof row.graph_options_use_transactions === "boolean"
          ? row.graph_options_use_transactions
          : true,
    },
  };
}

/**
 * Updates or inserts accounts associated with given user.
 */
export const upsertAccounts = async (user: MaskedUser, accounts: JSONAccount[]) => {
  if (!accounts.length) return [];
  const { user_id } = user;
  const results: { update: { _id: string }; status: number }[] = [];

  for (const account of accounts) {
    const row = accountToRow(account);
    row.user_id = user_id;

    try {
      const columns = Object.keys(row);
      const values = Object.values(row);
      const placeholders = values.map((_, i) => `$${i + 1}`);

      const updateClauses = columns
        .filter((col) => col !== "account_id" && col !== "user_id")
        .map((col) => `${col} = EXCLUDED.${col}`);
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
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to upsert account ${account.account_id}:`, message);
      results.push({
        update: { _id: account.account_id },
        status: 500,
      });
    }
  }

  return results;
};

/**
 * Updates accounts associated with given user.
 */
export const updateAccounts = async (user: MaskedUser, accounts: PartialAccount[]) => {
  if (!accounts.length) return [];
  const { user_id } = user;
  const results: { update: { _id: string }; status: number }[] = [];

  for (const account of accounts) {
    const row = accountToRow(account);
    row.user_id = user_id;

    try {
      const updateData = { ...row };
      delete updateData.account_id;
      delete updateData.user_id;

      const queryResult = buildUpdateQuery(
        "accounts",
        "account_id",
        account.account_id,
        updateData,
        { additionalWhere: { column: "user_id", value: user_id }, returning: ["account_id"] },
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
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to upsert account ${account.account_id}:`, message);
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
    [user_id],
  );
  return result.rows.map(rowToAccount);
};

export const getAccount = async (
  user: MaskedUser,
  account_id: string,
): Promise<JSONAccount | null> => {
  const { user_id } = user;
  const result = await pool.query(
    `SELECT * FROM accounts WHERE account_id = $1 AND user_id = $2 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [account_id, user_id],
  );
  return result.rows.length > 0 ? rowToAccount(result.rows[0]) : null;
};

/**
 * Deletes accounts (soft delete).
 * Cascades: soft-deletes child transactions, investment_transactions, split_transactions, snapshots, holdings.
 */
export const deleteAccounts = async (
  user: MaskedUser,
  account_ids: string[],
): Promise<{ deleted: number }> => {
  if (!account_ids.length) return { deleted: 0 };
  const { user_id } = user;

  const placeholders = account_ids.map((_, i) => `$${i + 2}`).join(", ");

  // Cascade: soft-delete transactions
  await pool.query(
    `UPDATE transactions SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE account_id IN (${placeholders}) AND user_id = $1`,
    [user_id, ...account_ids],
  );

  // Cascade: soft-delete investment_transactions
  await pool.query(
    `UPDATE investment_transactions SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE account_id IN (${placeholders}) AND user_id = $1`,
    [user_id, ...account_ids],
  );

  // Cascade: soft-delete split_transactions
  await pool.query(
    `UPDATE split_transactions SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE account_id IN (${placeholders}) AND user_id = $1`,
    [user_id, ...account_ids],
  );

  // Cascade: soft-delete snapshots
  await pool.query(
    `UPDATE snapshots SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE account_id IN (${placeholders}) AND user_id = $1`,
    [user_id, ...account_ids],
  );

  // Cascade: soft-delete holdings
  await pool.query(
    `UPDATE holdings SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE account_id IN (${placeholders}) AND user_id = $1`,
    [user_id, ...account_ids],
  );

  const result = await pool.query(
    `UPDATE accounts SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP 
     WHERE account_id IN (${placeholders}) AND user_id = $1
     RETURNING account_id`,
    [user_id, ...account_ids],
  );

  return { deleted: result.rowCount || 0 };
};

export const getAccountsByItem = async (
  user: MaskedUser,
  item_id: string,
): Promise<JSONAccount[]> => {
  const { user_id } = user;
  const result = await pool.query(
    `SELECT * FROM accounts WHERE item_id = $1 AND user_id = $2 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [item_id, user_id],
  );
  return result.rows.map(rowToAccount);
};

// =====================================
// Holdings operations
// =====================================

function holdingToRow(holding: Partial<JSONHolding>): Partial<HoldingRow> {
  const row: Partial<HoldingRow> = {};

  if (!isUndefined(holding.account_id)) row.account_id = holding.account_id;
  if (!isUndefined(holding.security_id)) row.security_id = holding.security_id;
  if (!isUndefined(holding.institution_price)) row.institution_price = holding.institution_price;
  if (!isUndefined(holding.institution_price_as_of))
    row.institution_price_as_of = holding.institution_price_as_of;
  if (!isUndefined(holding.institution_value)) row.institution_value = holding.institution_value;
  if (!isUndefined(holding.cost_basis)) row.cost_basis = holding.cost_basis;
  if (!isUndefined(holding.quantity)) row.quantity = holding.quantity;
  if (!isUndefined(holding.iso_currency_code)) row.iso_currency_code = holding.iso_currency_code;

  // Store full provider object in raw
  row.raw = JSON.stringify(holding);

  return row;
}

function rowToHolding(row: HoldingRow): JSONHolding {
  return {
    holding_id: row.holding_id,
    account_id: row.account_id,
    security_id: row.security_id,
    institution_price: row.institution_price ? Number(row.institution_price) : 0,
    institution_value: row.institution_value ? Number(row.institution_value) : 0,
    cost_basis: row.cost_basis ? Number(row.cost_basis) : 0,
    quantity: row.quantity ? Number(row.quantity) : 0,
    iso_currency_code: row.iso_currency_code || "USD",
    institution_price_as_of: row.institution_price_as_of,
    unofficial_currency_code: null,
  };
}

export const upsertHoldings = async (
  user: MaskedUser,
  holdings: (Partial<JSONHolding> & { holding_id?: string })[],
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
        .filter((col) => col !== "holding_id" && col !== "user_id")
        .map((col) => `${col} = EXCLUDED.${col}`);
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
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to upsert holding ${holding_id}:`, message);
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
    [user_id],
  );
  return result.rows.map(rowToHolding);
};

export const deleteHoldings = async (
  user: MaskedUser,
  holding_ids: string[],
): Promise<{ deleted: number }> => {
  if (!holding_ids.length) return { deleted: 0 };
  const { user_id } = user;

  const placeholders = holding_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `UPDATE holdings SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP 
     WHERE holding_id IN (${placeholders}) AND user_id = $1
     RETURNING holding_id`,
    [user_id, ...holding_ids],
  );

  return { deleted: result.rowCount || 0 };
};

// =====================================
// Institutions operations
// =====================================

function institutionToRow(institution: Partial<JSONInstitution>): Partial<InstitutionRow> {
  const row: Partial<InstitutionRow> = {};

  if (institution.institution_id !== undefined) row.institution_id = institution.institution_id;
  if (institution.name !== undefined) row.name = institution.name;

  // Store full provider object in raw
  row.raw = JSON.stringify(institution);

  return row;
}

function rowToInstitution(row: InstitutionRow): JSONInstitution {
  return {
    institution_id: row.institution_id,
    name: row.name || "Unknown",
    products: [],
    country_codes: [],
    url: null,
    primary_color: null,
    logo: null,
    routing_numbers: [],
    oauth: false,
    status: null,
  };
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
        .filter((col) => col !== "institution_id")
        .map((col) => `${col} = EXCLUDED.${col}`);
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
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to upsert institution ${institution.institution_id}:`, message);
      results.push({
        update: { _id: institution.institution_id },
        status: 500,
      });
    }
  }

  return results;
};

export const getInstitution = async (institution_id: string): Promise<JSONInstitution | null> => {
  const result = await pool.query(`SELECT * FROM institutions WHERE institution_id = $1`, [
    institution_id,
  ]);
  return result.rows.length > 0 ? rowToInstitution(result.rows[0]) : null;
};

// =====================================
// Securities operations
// =====================================

function securityToRow(security: Partial<JSONSecurity>): Partial<SecurityRow> {
  const row: Partial<SecurityRow> = {};

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

function rowToSecurity(row: SecurityRow): JSONSecurity {
  return {
    security_id: row.security_id,
    name: row.name ?? null,
    ticker_symbol: row.ticker_symbol ?? null,
    type: row.type ?? null,
    close_price: row.close_price != null ? Number(row.close_price) : null,
    close_price_as_of: row.close_price_as_of ?? null,
    iso_currency_code: row.iso_currency_code ?? null,
    isin: row.isin ?? null,
    cusip: row.cusip ?? null,
    // Remaining fields from raw
    sedol: null,
    institution_security_id: null,
    institution_id: null,
    proxy_security_id: null,
    is_cash_equivalent: null,
    unofficial_currency_code: null,
    market_identifier_code: null,
    sector: null,
    industry: null,
    option_contract: null,
    fixed_income: null,
  };
}

export const upsertSecurities = async (securities: JSONSecurity[]) => {
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
        .filter((col) => col !== "security_id")
        .map((col) => `${col} = EXCLUDED.${col}`);
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
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to upsert security ${security.security_id}:`, message);
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
    [user_id],
  );
  return result.rows.map(rowToSecurity);
};

export const getSecurity = async (security_id: string): Promise<JSONSecurity | null> => {
  const result = await pool.query(`SELECT * FROM securities WHERE security_id = $1`, [security_id]);
  return result.rows.length > 0 ? rowToSecurity(result.rows[0]) : null;
};

export const searchSecurities = async (
  options: string[] | { security_id?: string; ticker_symbol?: string; security_ids?: string[] },
): Promise<JSONSecurity[]> => {
  if (Array.isArray(options)) {
    if (!options.length) return [];
    const placeholders = options.map((_, i) => `$${i + 1}`).join(", ");
    const result = await pool.query(
      `SELECT * FROM securities WHERE security_id IN (${placeholders})`,
      options,
    );
    return result.rows.map(rowToSecurity);
  }

  const conditions: string[] = [];
  const values: (string | string[])[] = [];
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
    values,
  );
  return result.rows.map(rowToSecurity);
};

export const searchAccountsByItemId = async (
  user: MaskedUser,
  item_id: string,
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
  } = {},
): Promise<JSONAccount[]> => {
  const { user_id } = user;
  const conditions: string[] = ["user_id = $1", "(is_deleted IS NULL OR is_deleted = FALSE)"];
  const values: string[] = [user_id];
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
    values,
  );
  return result.rows.map(rowToAccount);
};

export const searchAccountsById = async (
  user: MaskedUser,
  account_ids: string[],
): Promise<JSONAccount[]> => {
  if (!account_ids.length) return [];
  const { user_id } = user;

  const placeholders = account_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `SELECT * FROM accounts 
     WHERE account_id IN (${placeholders}) AND user_id = $1 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [user_id, ...account_ids],
  );
  return result.rows.map(rowToAccount);
};

export const searchInstitutionById = async (
  institution_id: string,
): Promise<JSONInstitution | null> => {
  return getInstitution(institution_id);
};

export const searchHoldingsByAccountId = async (
  user: MaskedUser,
  account_ids: string[],
): Promise<JSONHolding[]> => {
  if (!account_ids.length) return [];
  const { user_id } = user;

  const placeholders = account_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `SELECT * FROM holdings 
     WHERE account_id IN (${placeholders}) AND user_id = $1 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [user_id, ...account_ids],
  );
  return result.rows.map(rowToHolding);
};
