import { JSONAccountSnapshot, JSONSecuritySnapshot, JSONHoldingSnapshot } from "common";
import { pool } from "./client";
import { MaskedUser } from "./users";

// Database row interface
interface SnapshotRow {
  snapshot_id: string;
  user_id?: string;
  snapshot_date: string | Date;
  snapshot_type: 'account_balance' | 'security' | 'holding';
  account_id?: string;
  security_id?: string;
  holding_account_id?: string;
  holding_security_id?: string;
  balances_available?: string | number;
  balances_current?: string | number;
  balances_limit?: string | number;
  balances_iso_currency_code?: string;
  close_price?: string | number;
  institution_price?: string | number;
  institution_value?: string | number;
  cost_basis?: string | number;
  quantity?: string | number;
  data?: string;
  updated?: Date;
  is_deleted?: boolean;
}

export interface SearchSnapshotsOptions {
  account_id?: string;
  account_ids?: string[];
  security_id?: string;
  snapshot_type?: 'account_balance' | 'security' | 'holding';
  startDate?: string;
  endDate?: string;
  limit?: number;
}

export interface AccountSnapshot {
  snapshot_id: string;
  snapshot_date: string;
  account_id: string;
  balances_available?: number;
  balances_current?: number;
  balances_limit?: number;
  balances_iso_currency_code?: string | null;
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
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to upsert account snapshot:`, message);
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
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to upsert security snapshot:`, message);
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
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to upsert holding snapshot:`, message);
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
  const conditions: string[] = ["user_id = $1", "snapshot_type = 'account_balance'", "(is_deleted IS NULL OR is_deleted = FALSE)"];
  const values: string[] = [user_id];
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

  const result = await pool.query<{
    snapshot_id: string;
    snapshot_date: string;
    account_id: string;
    balances_available: string | null;
    balances_current: string | null;
    balances_limit: string | null;
    balances_iso_currency_code: string | null;
  }>(
    `SELECT snapshot_id, snapshot_date, account_id, 
            balances_available, balances_current, balances_limit, balances_iso_currency_code
     FROM snapshots WHERE ${conditions.join(" AND ")} ORDER BY snapshot_date`,
    values
  );

  return result.rows.map((row) => ({
    snapshot_id: row.snapshot_id,
    snapshot_date: row.snapshot_date,
    account_id: row.account_id,
    balances_available: row.balances_available != null ? Number(row.balances_available) : undefined,
    balances_current: row.balances_current != null ? Number(row.balances_current) : undefined,
    balances_limit: row.balances_limit != null ? Number(row.balances_limit) : undefined,
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
  const conditions: string[] = ["snapshot_type = 'security'", "(is_deleted IS NULL OR is_deleted = FALSE)"];
  const values: string[] = [];
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

  const result = await pool.query<{
    snapshot_id: string;
    snapshot_date: string;
    security_id: string;
    close_price: string | null;
  }>(
    `SELECT snapshot_id, snapshot_date, security_id, close_price
     FROM snapshots WHERE ${conditions.join(" AND ")} ORDER BY snapshot_date`,
    values
  );

  return result.rows.map((row) => ({
    snapshot_id: row.snapshot_id,
    snapshot_date: row.snapshot_date,
    security_id: row.security_id,
    close_price: row.close_price != null ? Number(row.close_price) : undefined,
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
  const conditions: string[] = ["user_id = $1", "snapshot_type = 'holding'", "(is_deleted IS NULL OR is_deleted = FALSE)"];
  const values: string[] = [user_id];
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

  const result = await pool.query<{
    snapshot_id: string;
    snapshot_date: string;
    holding_account_id: string;
    holding_security_id: string;
    institution_price: string | null;
    institution_value: string | null;
    cost_basis: string | null;
    quantity: string | null;
  }>(
    `SELECT snapshot_id, snapshot_date, holding_account_id, holding_security_id,
            institution_price, institution_value, cost_basis, quantity
     FROM snapshots WHERE ${conditions.join(" AND ")} ORDER BY snapshot_date`,
    values
  );

  return result.rows.map((row) => ({
    snapshot_id: row.snapshot_id,
    snapshot_date: row.snapshot_date,
    holding_account_id: row.holding_account_id,
    holding_security_id: row.holding_security_id,
    institution_price: row.institution_price != null ? Number(row.institution_price) : undefined,
    institution_value: row.institution_value != null ? Number(row.institution_value) : undefined,
    cost_basis: row.cost_basis != null ? Number(row.cost_basis) : undefined,
    quantity: row.quantity != null ? Number(row.quantity) : undefined,
  }));
};

/**
 * Soft-deletes snapshots older than a certain date.
 */
export const deleteOldSnapshots = async (
  beforeDate: string
): Promise<{ deleted: number }> => {
  const result = await pool.query(
    `UPDATE snapshots SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE snapshot_date < $1 AND (is_deleted IS NULL OR is_deleted = FALSE) RETURNING snapshot_id`,
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
  
  const result = await pool.query<{
    snapshot_id: string;
    snapshot_date: string;
    account_id: string;
    balances_available: string | null;
    balances_current: string | null;
    balances_limit: string | null;
    balances_iso_currency_code: string | null;
  }>(
    `SELECT DISTINCT ON (account_id) 
            snapshot_id, snapshot_date, account_id,
            balances_available, balances_current, balances_limit, balances_iso_currency_code
     FROM snapshots 
     WHERE user_id = $1 AND snapshot_type = 'account_balance' AND (is_deleted IS NULL OR is_deleted = FALSE)
     ORDER BY account_id, snapshot_date DESC`,
    [user_id]
  );

  return result.rows.map(row => ({
    snapshot_id: row.snapshot_id,
    snapshot_date: row.snapshot_date,
    account_id: row.account_id,
    balances_available: row.balances_available != null ? Number(row.balances_available) : undefined,
    balances_current: row.balances_current != null ? Number(row.balances_current) : undefined,
    balances_limit: row.balances_limit != null ? Number(row.balances_limit) : undefined,
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
  const conditions: string[] = ["user_id = $1", "snapshot_type = 'account_balance'", "(is_deleted IS NULL OR is_deleted = FALSE)"];
  const values: string[] = [user_id];
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

/**
 * Transforms a raw snapshot row to JSONAccountSnapshot format.
 */
function rowToAccountSnapshot(row: SnapshotRow): JSONAccountSnapshot {
  return {
    snapshot: {
      snapshot_id: row.snapshot_id,
      date: row.snapshot_date instanceof Date ? row.snapshot_date.toISOString() : String(row.snapshot_date),
    },
    user: { user_id: row.user_id ?? "" },
    account: {
      account_id: row.account_id ?? "",
      balances: {
        current: row.balances_current != null ? Number(row.balances_current) : null,
        available: row.balances_available != null ? Number(row.balances_available) : null,
        limit: row.balances_limit != null ? Number(row.balances_limit) : null,
        iso_currency_code: row.balances_iso_currency_code ?? null,
        unofficial_currency_code: null,
      },
    },
  } as JSONAccountSnapshot;
}

/**
 * Transforms a raw snapshot row to JSONSecuritySnapshot format.
 */
function rowToSecuritySnapshot(row: SnapshotRow): JSONSecuritySnapshot {
  return {
    snapshot: {
      snapshot_id: row.snapshot_id,
      date: row.snapshot_date instanceof Date ? row.snapshot_date.toISOString() : String(row.snapshot_date),
    },
    security: {
      security_id: row.security_id ?? "",
      close_price: row.close_price != null ? Number(row.close_price) : null,
    },
  } as JSONSecuritySnapshot;
}

/**
 * Transforms a raw snapshot row to JSONHoldingSnapshot format.
 */
function rowToHoldingSnapshot(row: SnapshotRow): JSONHoldingSnapshot {
  return {
    snapshot: {
      snapshot_id: row.snapshot_id,
      date: row.snapshot_date instanceof Date ? row.snapshot_date.toISOString() : String(row.snapshot_date),
    },
    user: { user_id: row.user_id ?? "" },
    holding: {
      account_id: row.holding_account_id ?? "",
      security_id: row.holding_security_id ?? "",
      institution_price: row.institution_price != null ? Number(row.institution_price) : 0,
      institution_value: row.institution_value != null ? Number(row.institution_value) : 0,
      cost_basis: row.cost_basis != null ? Number(row.cost_basis) : 0,
      quantity: row.quantity != null ? Number(row.quantity) : 0,
    },
  } as JSONHoldingSnapshot;
}

/**
 * Searches snapshots with flexible options.
 * Returns snapshots in JSONSnapshotData format (JSONAccountSnapshot, JSONSecuritySnapshot, or JSONHoldingSnapshot).
 */
export const searchSnapshots = async (
  user: MaskedUser | null,
  options: SearchSnapshotsOptions = {}
): Promise<(JSONAccountSnapshot | JSONSecuritySnapshot | JSONHoldingSnapshot)[]> => {
  const conditions: string[] = ["(is_deleted IS NULL OR is_deleted = FALSE)"];
  const values: (string | number)[] = [];
  let paramIndex = 1;

  if (user) {
    conditions.push(`user_id = $${paramIndex}`);
    values.push(user.user_id);
    paramIndex++;
  }

  if (options.snapshot_type) {
    conditions.push(`snapshot_type = $${paramIndex}`);
    values.push(options.snapshot_type);
    paramIndex++;
  }

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

  let query = `SELECT * FROM snapshots`;
  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(" AND ")}`;
  }
  query += ` ORDER BY snapshot_date DESC`;

  if (options.limit) {
    query += ` LIMIT $${paramIndex}`;
    values.push(options.limit);
  }

  const result = await pool.query<SnapshotRow>(query, values);
  
  // Transform raw rows to JSONSnapshotData format based on snapshot_type
  return result.rows.map((row): JSONAccountSnapshot | JSONSecuritySnapshot | JSONHoldingSnapshot => {
    switch (row.snapshot_type) {
      case 'account_balance':
        return rowToAccountSnapshot(row);
      case 'security':
        return rowToSecuritySnapshot(row);
      case 'holding':
        return rowToHoldingSnapshot(row);
      default:
        // Default to account snapshot for unknown types
        return rowToAccountSnapshot(row);
    }
  });
};

/**
 * Soft-deletes snapshots by account ID.
 */
export const deleteSnapshotsByAccount = async (
  user: MaskedUser,
  account_id: string
): Promise<{ deleted: number }> => {
  const { user_id } = user;
  const result = await pool.query(
    `UPDATE snapshots SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE account_id = $1 AND user_id = $2 AND (is_deleted IS NULL OR is_deleted = FALSE) RETURNING snapshot_id`,
    [account_id, user_id]
  );
  return { deleted: result.rowCount || 0 };
};

/**
 * Soft-deletes all snapshots for a user.
 */
export const deleteSnapshotsByUser = async (
  user: MaskedUser
): Promise<{ deleted: number }> => {
  const { user_id } = user;
  const result = await pool.query(
    `UPDATE snapshots SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE user_id = $1 AND (is_deleted IS NULL OR is_deleted = FALSE) RETURNING snapshot_id`,
    [user_id]
  );
  return { deleted: result.rowCount || 0 };
};

/**
 * Soft-deletes a specific snapshot by ID.
 */
export const deleteSnapshotById = async (
  user: MaskedUser,
  snapshot_id: string
): Promise<boolean> => {
  const { user_id } = user;
  const result = await pool.query(
    `UPDATE snapshots SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE snapshot_id = $1 AND user_id = $2 AND (is_deleted IS NULL OR is_deleted = FALSE) RETURNING snapshot_id`,
    [snapshot_id, user_id]
  );
  return (result.rowCount || 0) > 0;
};

// Type guards for snapshot types
function isAccountSnapshot(data: JSONAccountSnapshot | JSONSecuritySnapshot | JSONHoldingSnapshot): data is JSONAccountSnapshot {
  return 'account' in data;
}

function isSecuritySnapshot(data: JSONAccountSnapshot | JSONSecuritySnapshot | JSONHoldingSnapshot): data is JSONSecuritySnapshot {
  return 'security' in data;
}

function isHoldingSnapshot(data: JSONAccountSnapshot | JSONSecuritySnapshot | JSONHoldingSnapshot): data is JSONHoldingSnapshot {
  return 'holding' in data;
}

/**
 * Generic snapshot upsert that handles JSONAccountSnapshot, JSONSecuritySnapshot, and JSONHoldingSnapshot.
 */
export const upsertSnapshots = async (
  snapshots: (JSONAccountSnapshot | JSONSecuritySnapshot | JSONHoldingSnapshot)[]
) => {
  if (!snapshots.length) return [];
  const results: { update: { _id: string }; status: number }[] = [];

  for (const snapshotData of snapshots) {
    const { snapshot } = snapshotData;
    if (!snapshot?.snapshot_id) continue;

    try {
      // Determine type based on what's present
      if (isAccountSnapshot(snapshotData)) {
        // Account snapshot
        const { account } = snapshotData;
        await pool.query(
          `INSERT INTO snapshots (
            snapshot_id, user_id, snapshot_date, snapshot_type, account_id,
            balances_available, balances_current, balances_limit, balances_iso_currency_code,
            data, updated
          ) VALUES ($1, $2, $3, 'account_balance', $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
          ON CONFLICT (snapshot_id) DO UPDATE SET
            balances_available = COALESCE($5, snapshots.balances_available),
            balances_current = COALESCE($6, snapshots.balances_current),
            balances_limit = COALESCE($7, snapshots.balances_limit),
            data = $9,
            updated = CURRENT_TIMESTAMP`,
          [
            snapshot.snapshot_id,
            snapshotData.user?.user_id,
            snapshot.date,
            account.account_id,
            account.balances?.available,
            account.balances?.current,
            account.balances?.limit,
            account.balances?.iso_currency_code,
            JSON.stringify({ snapshot, account }),
          ]
        );
      } else if (isSecuritySnapshot(snapshotData)) {
        // Security snapshot
        const { security } = snapshotData;
        await pool.query(
          `INSERT INTO snapshots (
            snapshot_id, snapshot_date, snapshot_type, security_id, close_price,
            data, updated
          ) VALUES ($1, $2, 'security', $3, $4, $5, CURRENT_TIMESTAMP)
          ON CONFLICT (snapshot_id) DO UPDATE SET
            close_price = COALESCE($4, snapshots.close_price),
            data = $5,
            updated = CURRENT_TIMESTAMP`,
          [
            snapshot.snapshot_id,
            snapshot.date,
            security.security_id,
            security.close_price,
            JSON.stringify({ snapshot, security }),
          ]
        );
      } else if (isHoldingSnapshot(snapshotData)) {
        // Holding snapshot
        const { holding } = snapshotData;
        await pool.query(
          `INSERT INTO snapshots (
            snapshot_id, user_id, snapshot_date, snapshot_type,
            holding_account_id, holding_security_id,
            institution_price, institution_value, cost_basis, quantity,
            data, updated
          ) VALUES ($1, $2, $3, 'holding', $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
          ON CONFLICT (snapshot_id) DO UPDATE SET
            institution_price = COALESCE($6, snapshots.institution_price),
            institution_value = COALESCE($7, snapshots.institution_value),
            cost_basis = COALESCE($8, snapshots.cost_basis),
            quantity = COALESCE($9, snapshots.quantity),
            data = $10,
            updated = CURRENT_TIMESTAMP`,
          [
            snapshot.snapshot_id,
            snapshotData.user?.user_id,
            snapshot.date,
            holding.account_id,
            holding.security_id,
            holding.institution_price,
            holding.institution_value,
            holding.cost_basis,
            holding.quantity,
            JSON.stringify({ snapshot, holding }),
          ]
        );
      }

      results.push({
        update: { _id: snapshot.snapshot_id },
        status: 200,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to upsert snapshot ${snapshot.snapshot_id}:`, message);
      results.push({
        update: { _id: snapshot.snapshot_id },
        status: 500,
      });
    }
  }

  return results;
};
