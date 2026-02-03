import { pool } from "./client";
import { MaskedUser } from "./users";

export interface AccountSnapshot {
  snapshot_id: string;
  snapshot_date: string;
  account_id: string;
  balances_available?: number;
  balances_current?: number;
  balances_limit?: number;
  balances_iso_currency_code?: string;
}

export interface SecuritySnapshot {
  snapshot_id: string;
  snapshot_date: string;
  security_id: string;
  close_price?: number;
}

export interface HoldingSnapshot {
  snapshot_id: string;
  snapshot_date: string;
  holding_account_id: string;
  holding_security_id: string;
  institution_price?: number;
  institution_value?: number;
  cost_basis?: number;
  quantity?: number;
}

export type Snapshot = AccountSnapshot | SecuritySnapshot | HoldingSnapshot;

/**
 * Upserts account balance snapshots.
 */
export const upsertAccountSnapshots = async (
  user: MaskedUser,
  snapshots: AccountSnapshot[]
) => {
  if (!snapshots.length) return [];
  const { user_id } = user;
  const results: { update: { _id: string }; status: number }[] = [];

  for (const snapshot of snapshots) {
    try {
      const result = await pool.query(
        `INSERT INTO snapshots (
          snapshot_id, user_id, snapshot_date, snapshot_type, account_id,
          balances_available, balances_current, balances_limit, balances_iso_currency_code,
          updated
        ) VALUES ($1, $2, $3, 'account_balance', $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
        ON CONFLICT (snapshot_id) DO UPDATE SET
          balances_available = COALESCE($5, snapshots.balances_available),
          balances_current = COALESCE($6, snapshots.balances_current),
          balances_limit = COALESCE($7, snapshots.balances_limit),
          balances_iso_currency_code = COALESCE($8, snapshots.balances_iso_currency_code),
          updated = CURRENT_TIMESTAMP
        RETURNING snapshot_id`,
        [
          snapshot.snapshot_id,
          user_id,
          snapshot.snapshot_date,
          snapshot.account_id,
          snapshot.balances_available,
          snapshot.balances_current,
          snapshot.balances_limit,
          snapshot.balances_iso_currency_code,
        ]
      );
      
      results.push({
        update: { _id: snapshot.snapshot_id },
        status: result.rowCount ? 200 : 404,
      });
    } catch (error: any) {
      console.error(`Failed to upsert account snapshot:`, error.message);
      results.push({
        update: { _id: snapshot.snapshot_id },
        status: 500,
      });
    }
  }

  return results;
};

/**
 * Upserts security price snapshots.
 */
export const upsertSecuritySnapshots = async (snapshots: SecuritySnapshot[]) => {
  if (!snapshots.length) return [];
  const results: { update: { _id: string }; status: number }[] = [];

  for (const snapshot of snapshots) {
    try {
      const result = await pool.query(
        `INSERT INTO snapshots (
          snapshot_id, snapshot_date, snapshot_type, security_id, close_price, updated
        ) VALUES ($1, $2, 'security', $3, $4, CURRENT_TIMESTAMP)
        ON CONFLICT (snapshot_id) DO UPDATE SET
          close_price = COALESCE($4, snapshots.close_price),
          updated = CURRENT_TIMESTAMP
        RETURNING snapshot_id`,
        [
          snapshot.snapshot_id,
          snapshot.snapshot_date,
          snapshot.security_id,
          snapshot.close_price,
        ]
      );
      
      results.push({
        update: { _id: snapshot.snapshot_id },
        status: result.rowCount ? 200 : 404,
      });
    } catch (error: any) {
      console.error(`Failed to upsert security snapshot:`, error.message);
      results.push({
        update: { _id: snapshot.snapshot_id },
        status: 500,
      });
    }
  }

  return results;
};

/**
 * Upserts holding snapshots.
 */
export const upsertHoldingSnapshots = async (
  user: MaskedUser,
  snapshots: HoldingSnapshot[]
) => {
  if (!snapshots.length) return [];
  const { user_id } = user;
  const results: { update: { _id: string }; status: number }[] = [];

  for (const snapshot of snapshots) {
    try {
      const result = await pool.query(
        `INSERT INTO snapshots (
          snapshot_id, user_id, snapshot_date, snapshot_type,
          holding_account_id, holding_security_id,
          institution_price, institution_value, cost_basis, quantity, updated
        ) VALUES ($1, $2, $3, 'holding', $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
        ON CONFLICT (snapshot_id) DO UPDATE SET
          institution_price = COALESCE($6, snapshots.institution_price),
          institution_value = COALESCE($7, snapshots.institution_value),
          cost_basis = COALESCE($8, snapshots.cost_basis),
          quantity = COALESCE($9, snapshots.quantity),
          updated = CURRENT_TIMESTAMP
        RETURNING snapshot_id`,
        [
          snapshot.snapshot_id,
          user_id,
          snapshot.snapshot_date,
          snapshot.holding_account_id,
          snapshot.holding_security_id,
          snapshot.institution_price,
          snapshot.institution_value,
          snapshot.cost_basis,
          snapshot.quantity,
        ]
      );
      
      results.push({
        update: { _id: snapshot.snapshot_id },
        status: result.rowCount ? 200 : 404,
      });
    } catch (error: any) {
      console.error(`Failed to upsert holding snapshot:`, error.message);
      results.push({
        update: { _id: snapshot.snapshot_id },
        status: 500,
      });
    }
  }

  return results;
};

/**
 * Gets account balance snapshots within a date range.
 */
export const getAccountSnapshots = async (
  user: MaskedUser,
  options: {
    account_id?: string;
    startDate?: string;
    endDate?: string;
  } = {}
): Promise<AccountSnapshot[]> => {
  const { user_id } = user;
  const conditions: string[] = ["user_id = $1", "snapshot_type = 'account_balance'"];
  const values: any[] = [user_id];
  let paramIndex = 2;

  if (options.account_id) {
    conditions.push(`account_id = $${paramIndex}`);
    values.push(options.account_id);
    paramIndex++;
  }

  if (options.startDate) {
    conditions.push(`snapshot_date >= $${paramIndex}`);
    values.push(options.startDate);
    paramIndex++;
  }

  if (options.endDate) {
    conditions.push(`snapshot_date <= $${paramIndex}`);
    values.push(options.endDate);
    paramIndex++;
  }

  const result = await pool.query(
    `SELECT snapshot_id, snapshot_date, account_id, 
            balances_available, balances_current, balances_limit, balances_iso_currency_code
     FROM snapshots WHERE ${conditions.join(" AND ")} ORDER BY snapshot_date`,
    values
  );

  return result.rows.map(row => ({
    snapshot_id: row.snapshot_id,
    snapshot_date: row.snapshot_date,
    account_id: row.account_id,
    balances_available: row.balances_available ? parseFloat(row.balances_available) : undefined,
    balances_current: row.balances_current ? parseFloat(row.balances_current) : undefined,
    balances_limit: row.balances_limit ? parseFloat(row.balances_limit) : undefined,
    balances_iso_currency_code: row.balances_iso_currency_code,
  }));
};

/**
 * Gets security snapshots within a date range.
 */
export const getSecuritySnapshots = async (
  options: {
    security_id?: string;
    startDate?: string;
    endDate?: string;
  } = {}
): Promise<SecuritySnapshot[]> => {
  const conditions: string[] = ["snapshot_type = 'security'"];
  const values: any[] = [];
  let paramIndex = 1;

  if (options.security_id) {
    conditions.push(`security_id = $${paramIndex}`);
    values.push(options.security_id);
    paramIndex++;
  }

  if (options.startDate) {
    conditions.push(`snapshot_date >= $${paramIndex}`);
    values.push(options.startDate);
    paramIndex++;
  }

  if (options.endDate) {
    conditions.push(`snapshot_date <= $${paramIndex}`);
    values.push(options.endDate);
    paramIndex++;
  }

  const result = await pool.query(
    `SELECT snapshot_id, snapshot_date, security_id, close_price
     FROM snapshots WHERE ${conditions.join(" AND ")} ORDER BY snapshot_date`,
    values
  );

  return result.rows.map(row => ({
    snapshot_id: row.snapshot_id,
    snapshot_date: row.snapshot_date,
    security_id: row.security_id,
    close_price: row.close_price ? parseFloat(row.close_price) : undefined,
  }));
};

/**
 * Gets holding snapshots within a date range.
 */
export const getHoldingSnapshots = async (
  user: MaskedUser,
  options: {
    account_id?: string;
    security_id?: string;
    startDate?: string;
    endDate?: string;
  } = {}
): Promise<HoldingSnapshot[]> => {
  const { user_id } = user;
  const conditions: string[] = ["user_id = $1", "snapshot_type = 'holding'"];
  const values: any[] = [user_id];
  let paramIndex = 2;

  if (options.account_id) {
    conditions.push(`holding_account_id = $${paramIndex}`);
    values.push(options.account_id);
    paramIndex++;
  }

  if (options.security_id) {
    conditions.push(`holding_security_id = $${paramIndex}`);
    values.push(options.security_id);
    paramIndex++;
  }

  if (options.startDate) {
    conditions.push(`snapshot_date >= $${paramIndex}`);
    values.push(options.startDate);
    paramIndex++;
  }

  if (options.endDate) {
    conditions.push(`snapshot_date <= $${paramIndex}`);
    values.push(options.endDate);
    paramIndex++;
  }

  const result = await pool.query(
    `SELECT snapshot_id, snapshot_date, holding_account_id, holding_security_id,
            institution_price, institution_value, cost_basis, quantity
     FROM snapshots WHERE ${conditions.join(" AND ")} ORDER BY snapshot_date`,
    values
  );

  return result.rows.map(row => ({
    snapshot_id: row.snapshot_id,
    snapshot_date: row.snapshot_date,
    holding_account_id: row.holding_account_id,
    holding_security_id: row.holding_security_id,
    institution_price: row.institution_price ? parseFloat(row.institution_price) : undefined,
    institution_value: row.institution_value ? parseFloat(row.institution_value) : undefined,
    cost_basis: row.cost_basis ? parseFloat(row.cost_basis) : undefined,
    quantity: row.quantity ? parseFloat(row.quantity) : undefined,
  }));
};

/**
 * Deletes snapshots older than a certain date.
 */
export const deleteOldSnapshots = async (
  beforeDate: string
): Promise<{ deleted: number }> => {
  const result = await pool.query(
    `DELETE FROM snapshots WHERE snapshot_date < $1 RETURNING snapshot_id`,
    [beforeDate]
  );
  
  return { deleted: result.rowCount || 0 };
};

/**
 * Gets the latest snapshot for each account.
 */
export const getLatestAccountSnapshots = async (
  user: MaskedUser
): Promise<AccountSnapshot[]> => {
  const { user_id } = user;
  
  const result = await pool.query(
    `SELECT DISTINCT ON (account_id) 
            snapshot_id, snapshot_date, account_id,
            balances_available, balances_current, balances_limit, balances_iso_currency_code
     FROM snapshots 
     WHERE user_id = $1 AND snapshot_type = 'account_balance'
     ORDER BY account_id, snapshot_date DESC`,
    [user_id]
  );

  return result.rows.map(row => ({
    snapshot_id: row.snapshot_id,
    snapshot_date: row.snapshot_date,
    account_id: row.account_id,
    balances_available: row.balances_available ? parseFloat(row.balances_available) : undefined,
    balances_current: row.balances_current ? parseFloat(row.balances_current) : undefined,
    balances_limit: row.balances_limit ? parseFloat(row.balances_limit) : undefined,
    balances_iso_currency_code: row.balances_iso_currency_code,
  }));
};

/**
 * Aggregates account balance snapshots by date for charting.
 */
export const aggregateAccountSnapshots = async (
  user: MaskedUser,
  options: {
    account_ids?: string[];
    startDate?: string;
    endDate?: string;
    interval?: 'day' | 'week' | 'month';
  } = {}
): Promise<{ date: string; total_current: number; total_available: number }[]> => {
  const { user_id } = user;
  const conditions: string[] = ["user_id = $1", "snapshot_type = 'account_balance'"];
  const values: any[] = [user_id];
  let paramIndex = 2;

  if (options.account_ids && options.account_ids.length > 0) {
    const placeholders = options.account_ids.map((_, i) => `$${paramIndex + i}`).join(", ");
    conditions.push(`account_id IN (${placeholders})`);
    values.push(...options.account_ids);
    paramIndex += options.account_ids.length;
  }

  if (options.startDate) {
    conditions.push(`snapshot_date >= $${paramIndex}`);
    values.push(options.startDate);
    paramIndex++;
  }

  if (options.endDate) {
    conditions.push(`snapshot_date <= $${paramIndex}`);
    values.push(options.endDate);
    paramIndex++;
  }

  const interval = options.interval || 'day';
  let dateGroup: string;
  switch (interval) {
    case 'week':
      dateGroup = "date_trunc('week', snapshot_date)";
      break;
    case 'month':
      dateGroup = "date_trunc('month', snapshot_date)";
      break;
    default:
      dateGroup = "date_trunc('day', snapshot_date)";
  }

  const result = await pool.query(
    `SELECT ${dateGroup} as date,
            SUM(COALESCE(balances_current, 0)) as total_current,
            SUM(COALESCE(balances_available, 0)) as total_available
     FROM snapshots 
     WHERE ${conditions.join(" AND ")}
     GROUP BY ${dateGroup}
     ORDER BY date`,
    values
  );

  return result.rows.map(row => ({
    date: row.date,
    total_current: parseFloat(row.total_current) || 0,
    total_available: parseFloat(row.total_available) || 0,
  }));
};
