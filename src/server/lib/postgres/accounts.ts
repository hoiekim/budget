import { JSONAccount, JSONHolding, JSONInstitution, JSONSecurity } from "common";
import { pool } from "./client";
import { MaskedUser } from "./users";

export type PartialAccount = { account_id: string } & Partial<JSONAccount>;

/**
 * Updates or inserts accounts documents associated with given user.
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
  const updated = new Date().toISOString();

  for (const account of accounts) {
    const { account_id, balances, label, graphOptions, ...rest } = account;

    if (upsert) {
      const result = await pool.query(
        `INSERT INTO accounts (account_id, user_id, balances, label, graph_options, data, updated)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (account_id) DO UPDATE SET
           balances = COALESCE($3, accounts.balances),
           label = COALESCE($4, accounts.label),
           graph_options = COALESCE($5, accounts.graph_options),
           data = accounts.data || $6,
           updated = $7
         WHERE accounts.user_id = $2
         RETURNING account_id`,
        [account_id, user_id, JSON.stringify(balances), JSON.stringify(label), JSON.stringify(graphOptions), JSON.stringify(rest), updated]
      );
      results.push({ update: { _id: account_id }, status: result.rowCount ? 200 : 404 });
    } else {
      const result = await pool.query(
        `UPDATE accounts SET
           balances = COALESCE($3, balances),
           label = COALESCE($4, label),
           graph_options = COALESCE($5, graph_options),
           data = data || $6,
           updated = $7
         WHERE account_id = $1 AND user_id = $2
         RETURNING account_id`,
        [account_id, user_id, JSON.stringify(balances), JSON.stringify(label), JSON.stringify(graphOptions), JSON.stringify(rest), updated]
      );
      results.push({ update: { _id: account_id }, status: result.rowCount ? 200 : 404 });
    }
  }

  return results;
};

/**
 * Searches for accounts associated with given user.
 * @param user
 * @returns A promise to be an object with accounts and holdings arrays
 */
export const searchAccounts = async (user: MaskedUser) => {
  const { user_id } = user;

  const accountsResult = await pool.query<{
    account_id: string;
    balances: any;
    label: any;
    graph_options: any;
    data: any;
  }>(
    `SELECT account_id, balances, label, graph_options, data FROM accounts WHERE user_id = $1`,
    [user_id]
  );

  const holdingsResult = await pool.query<{
    holding_id: string;
    data: any;
  }>(
    `SELECT holding_id, data FROM holdings WHERE user_id = $1`,
    [user_id]
  );

  const accounts: JSONAccount[] = accountsResult.rows.map((row) => ({
    ...row.data,
    account_id: row.account_id,
    balances: row.balances,
    label: row.label || {},
    graphOptions: row.graph_options || {},
  }));

  const holdings: JSONHolding[] = holdingsResult.rows.map((row) => ({
    ...row.data,
    holding_id: row.holding_id,
  }));

  return { accounts, holdings };
};

/**
 * Searches for accounts associated with given user and account ids.
 * @param user
 * @param accountIds
 * @returns A promise to be an array of Account objects
 */
export const searchAccountsById = async (user: MaskedUser, accountIds: string[]) => {
  if (!accountIds.length) return [];
  const { user_id } = user;

  const result = await pool.query<{
    account_id: string;
    balances: any;
    label: any;
    graph_options: any;
    data: any;
  }>(
    `SELECT account_id, balances, label, graph_options, data 
     FROM accounts 
     WHERE user_id = $1 AND account_id = ANY($2)`,
    [user_id, accountIds]
  );

  return result.rows.map((row) => ({
    ...row.data,
    account_id: row.account_id,
    balances: row.balances,
    label: row.label || {},
    graphOptions: row.graph_options || {},
  })) as JSONAccount[];
};

/**
 * Searches for accounts associated with given user and item id.
 * @param user
 * @param item_id
 * @returns A promise to be an array of Account objects
 */
export const searchAccountsByItemId = async (user: MaskedUser, item_id: string) => {
  const { user_id } = user;

  const result = await pool.query<{
    account_id: string;
    balances: any;
    label: any;
    graph_options: any;
    data: any;
  }>(
    `SELECT account_id, balances, label, graph_options, data 
     FROM accounts 
     WHERE user_id = $1 AND data->>'item_id' = $2`,
    [user_id, item_id]
  );

  return result.rows.map((row) => ({
    ...row.data,
    account_id: row.account_id,
    balances: row.balances,
    label: row.label || {},
    graphOptions: row.graph_options || {},
  })) as JSONAccount[];
};

export interface RemovedAccount {
  account_id: string;
}

/**
 * Deletes accounts by account_id in given accounts data.
 * @param user
 * @param accounts
 * @returns A promise with the delete result
 */
export const deleteAccounts = async (
  user: MaskedUser,
  accounts: (JSONAccount | RemovedAccount)[]
) => {
  if (!Array.isArray(accounts) || !accounts.length) return;
  const { user_id } = user;

  const accountIds = accounts.map((e) => e.account_id);

  const result = await pool.query(
    `DELETE FROM accounts WHERE user_id = $1 AND account_id = ANY($2)`,
    [user_id, accountIds]
  );

  return { deleted: result.rowCount };
};

export const searchHoldingsByAccountId = async (user: MaskedUser, accountIds: string[]) => {
  if (!Array.isArray(accountIds) || !accountIds.length) return [];
  const { user_id } = user;

  const result = await pool.query<{
    holding_id: string;
    data: any;
  }>(
    `SELECT holding_id, data FROM holdings 
     WHERE user_id = $1 AND data->>'account_id' = ANY($2)`,
    [user_id, accountIds]
  );

  return result.rows.map((row) => ({
    ...row.data,
    holding_id: row.holding_id,
  })) as JSONHolding[];
};

export type PartialHolding = { holding_id: string } & Partial<JSONHolding>;

export const upsertHoldings = async (
  user: MaskedUser,
  holdings: PartialHolding[],
  upsert: boolean = true
) => {
  if (!holdings.length) return [];
  const { user_id } = user;
  const results: { update: { _id: string }; status: number }[] = [];
  const updated = new Date().toISOString();

  for (const holding of holdings) {
    const { holding_id, ...rest } = holding;

    if (upsert) {
      const result = await pool.query(
        `INSERT INTO holdings (holding_id, user_id, data, updated)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (holding_id) DO UPDATE SET
           data = holdings.data || $3,
           updated = $4
         WHERE holdings.user_id = $2
         RETURNING holding_id`,
        [holding_id, user_id, JSON.stringify(rest), updated]
      );
      results.push({ update: { _id: holding_id }, status: result.rowCount ? 200 : 404 });
    } else {
      const result = await pool.query(
        `UPDATE holdings SET data = data || $3, updated = $4
         WHERE holding_id = $1 AND user_id = $2
         RETURNING holding_id`,
        [holding_id, user_id, JSON.stringify(rest), updated]
      );
      results.push({ update: { _id: holding_id }, status: result.rowCount ? 200 : 404 });
    }
  }

  return results;
};

export interface RemovedHolding {
  holding_id: string;
}

export const deleteHoldings = async (
  user: MaskedUser,
  holdings: (JSONHolding | RemovedHolding)[]
) => {
  if (!Array.isArray(holdings) || !holdings.length) return;
  const { user_id } = user;

  const holdingIds = holdings.map((e) => e.holding_id);

  const result = await pool.query(
    `DELETE FROM holdings WHERE user_id = $1 AND holding_id = ANY($2)`,
    [user_id, holdingIds]
  );

  return { deleted: result.rowCount };
};

export const searchSecurities = async (query: Partial<JSONSecurity>) => {
  const conditions: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      conditions.push(`data->>'${key}' = $${paramIndex++}`);
      values.push(String(value));
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await pool.query<{
    security_id: string;
    data: any;
  }>(`SELECT security_id, data FROM securities ${whereClause}`, values);

  return result.rows.map((row) => ({
    ...row.data,
    security_id: row.security_id,
  })) as JSONSecurity[];
};

export const searchSecuritiesById = async (securityIds: string[]) => {
  if (!securityIds.length) return [];

  const result = await pool.query<{
    security_id: string;
    data: any;
  }>(
    `SELECT security_id, data FROM securities WHERE security_id = ANY($1)`,
    [securityIds]
  );

  return result.rows.map((row) => ({
    ...row.data,
    security_id: row.security_id,
  })) as JSONSecurity[];
};

export type PartialSecurity = { security_id: string } & Partial<JSONSecurity>;

export const upsertSecurities = async (securities: PartialSecurity[], upsert: boolean = true) => {
  if (!securities.length) return [];
  const results: { update: { _id: string }; status: number }[] = [];
  const updated = new Date().toISOString();

  for (const security of securities) {
    const { security_id, ...rest } = security;

    if (upsert) {
      const result = await pool.query(
        `INSERT INTO securities (security_id, data, updated)
         VALUES ($1, $2, $3)
         ON CONFLICT (security_id) DO UPDATE SET
           data = securities.data || $2,
           updated = $3
         RETURNING security_id`,
        [security_id, JSON.stringify(rest), updated]
      );
      results.push({ update: { _id: security_id }, status: result.rowCount ? 200 : 404 });
    } else {
      const result = await pool.query(
        `UPDATE securities SET data = data || $2, updated = $3
         WHERE security_id = $1
         RETURNING security_id`,
        [security_id, JSON.stringify(rest), updated]
      );
      results.push({ update: { _id: security_id }, status: result.rowCount ? 200 : 404 });
    }
  }

  return results;
};

/**
 * Searches for institution associated with given id.
 * @param id
 * @returns A promise to be an Institution object or undefined
 */
export const searchInstitutionById = async (id: string): Promise<JSONInstitution | undefined> => {
  const result = await pool.query<{
    institution_id: string;
    data: any;
  }>(
    `SELECT institution_id, data FROM institutions WHERE institution_id = $1`,
    [id]
  );

  if (result.rows.length === 0) return undefined;

  const row = result.rows[0];
  return {
    ...row.data,
    institution_id: row.institution_id,
  } as JSONInstitution;
};

export type PartialInstitution = { institution_id: string } & Partial<JSONInstitution>;

export const upsertInstitutions = async (
  institutions: PartialInstitution[],
  upsert: boolean = true
) => {
  if (!institutions.length) return [];
  const results: { update: { _id: string }; status: number }[] = [];
  const updated = new Date().toISOString();

  for (const institution of institutions) {
    const { institution_id, ...rest } = institution;

    if (upsert) {
      const result = await pool.query(
        `INSERT INTO institutions (institution_id, data, updated)
         VALUES ($1, $2, $3)
         ON CONFLICT (institution_id) DO UPDATE SET
           data = institutions.data || $2,
           updated = $3
         RETURNING institution_id`,
        [institution_id, JSON.stringify(rest), updated]
      );
      results.push({ update: { _id: institution_id }, status: result.rowCount ? 200 : 404 });
    } else {
      const result = await pool.query(
        `UPDATE institutions SET data = data || $2, updated = $3
         WHERE institution_id = $1
         RETURNING institution_id`,
        [institution_id, JSON.stringify(rest), updated]
      );
      results.push({ update: { _id: institution_id }, status: result.rowCount ? 200 : 404 });
    }
  }

  return results;
};
