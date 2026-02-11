/**
 * Snapshot repository - CRUD operations for snapshots.
 */

import {
  JSONAccountSnapshot,
  JSONSecuritySnapshot,
  JSONHoldingSnapshot,
  JSONSnapshotData,
} from "common";
import { pool } from "../client";
import {
  MaskedUser,
  SnapshotModel,
  SnapshotRow,
  isAccountSnapshot,
  isSecuritySnapshot,
  isHoldingSnapshot,
  SNAPSHOTS,
  SNAPSHOT_ID,
  SNAPSHOT_TYPE,
  SNAPSHOT_DATE,
  ACCOUNT_ID,
  SECURITY_ID,
  USER_ID,
} from "../models";
import { UpsertResult, successResult, errorResult, buildSelectWithFilters } from "../database";

// Types

export interface SearchSnapshotsOptions {
  account_id?: string;
  account_ids?: string[];
  security_id?: string;
  snapshot_type?: "account_balance" | "security" | "holding";
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

// Query Helpers

const rowToSnapshot = (row: SnapshotRow): JSONSnapshotData =>
  new SnapshotModel(row).toJSON();

// Repository Functions

/**
 * Searches snapshots with flexible options.
 */
export const searchSnapshots = async (
  user: MaskedUser | null,
  options: SearchSnapshotsOptions = {}
): Promise<JSONSnapshotData[]> => {
  const { sql, values } = buildSelectWithFilters(SNAPSHOTS, "*", {
    user_id: user?.user_id,
    filters: {
      [SNAPSHOT_TYPE]: options.snapshot_type,
      [ACCOUNT_ID]: options.account_id,
      [SECURITY_ID]: options.security_id,
    },
    inFilters: options.account_ids?.length
      ? { [ACCOUNT_ID]: options.account_ids }
      : undefined,
    dateRange: options.startDate || options.endDate
      ? { column: SNAPSHOT_DATE, start: options.startDate, end: options.endDate }
      : undefined,
    orderBy: `${SNAPSHOT_DATE} DESC`,
    limit: options.limit,
  });

  const result = await pool.query<SnapshotRow>(sql, values);
  return result.rows.map(rowToSnapshot);
};

/**
 * Gets account snapshots.
 */
export const getAccountSnapshots = async (
  user: MaskedUser,
  options: {
    account_id?: string;
    startDate?: string;
    endDate?: string;
  } = {}
): Promise<AccountSnapshot[]> => {
  const conditions: string[] = [
    `${USER_ID} = $1`,
    `${SNAPSHOT_TYPE} = 'account_balance'`,
    "(is_deleted IS NULL OR is_deleted = FALSE)",
  ];
  const values: string[] = [user.user_id];
  let paramIndex = 2;

  if (options.account_id) {
    conditions.push(`${ACCOUNT_ID} = $${paramIndex++}`);
    values.push(options.account_id);
  }

  if (options.startDate) {
    conditions.push(`${SNAPSHOT_DATE} >= $${paramIndex++}`);
    values.push(options.startDate);
  }

  if (options.endDate) {
    conditions.push(`${SNAPSHOT_DATE} <= $${paramIndex++}`);
    values.push(options.endDate);
  }

  const result = await pool.query<SnapshotRow>(
    `SELECT * FROM ${SNAPSHOTS} WHERE ${conditions.join(" AND ")} ORDER BY ${SNAPSHOT_DATE}`,
    values
  );

  return result.rows.map((row) => ({
    snapshot_id: row.snapshot_id,
    snapshot_date: String(row.snapshot_date),
    account_id: row.account_id!,
    balances_available: row.balances_available != null ? Number(row.balances_available) : undefined,
    balances_current: row.balances_current != null ? Number(row.balances_current) : undefined,
    balances_limit: row.balances_limit != null ? Number(row.balances_limit) : undefined,
    balances_iso_currency_code: row.balances_iso_currency_code,
  }));
};

/**
 * Gets security snapshots.
 */
export const getSecuritySnapshots = async (
  options: {
    security_id?: string;
    startDate?: string;
    endDate?: string;
  } = {}
): Promise<SecuritySnapshot[]> => {
  const conditions: string[] = [
    `${SNAPSHOT_TYPE} = 'security'`,
    "(is_deleted IS NULL OR is_deleted = FALSE)",
  ];
  const values: string[] = [];
  let paramIndex = 1;

  if (options.security_id) {
    conditions.push(`${SECURITY_ID} = $${paramIndex++}`);
    values.push(options.security_id);
  }

  if (options.startDate) {
    conditions.push(`${SNAPSHOT_DATE} >= $${paramIndex++}`);
    values.push(options.startDate);
  }

  if (options.endDate) {
    conditions.push(`${SNAPSHOT_DATE} <= $${paramIndex++}`);
    values.push(options.endDate);
  }

  const result = await pool.query<SnapshotRow>(
    `SELECT * FROM ${SNAPSHOTS} WHERE ${conditions.join(" AND ")} ORDER BY ${SNAPSHOT_DATE}`,
    values
  );

  return result.rows.map((row) => ({
    snapshot_id: row.snapshot_id,
    snapshot_date: String(row.snapshot_date),
    security_id: row.security_id!,
    close_price: row.close_price != null ? Number(row.close_price) : undefined,
  }));
};

/**
 * Gets holding snapshots.
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
  const conditions: string[] = [
    `${USER_ID} = $1`,
    `${SNAPSHOT_TYPE} = 'holding'`,
    "(is_deleted IS NULL OR is_deleted = FALSE)",
  ];
  const values: string[] = [user.user_id];
  let paramIndex = 2;

  if (options.account_id) {
    conditions.push(`holding_account_id = $${paramIndex++}`);
    values.push(options.account_id);
  }

  if (options.security_id) {
    conditions.push(`holding_security_id = $${paramIndex++}`);
    values.push(options.security_id);
  }

  if (options.startDate) {
    conditions.push(`${SNAPSHOT_DATE} >= $${paramIndex++}`);
    values.push(options.startDate);
  }

  if (options.endDate) {
    conditions.push(`${SNAPSHOT_DATE} <= $${paramIndex++}`);
    values.push(options.endDate);
  }

  const result = await pool.query<SnapshotRow>(
    `SELECT * FROM ${SNAPSHOTS} WHERE ${conditions.join(" AND ")} ORDER BY ${SNAPSHOT_DATE}`,
    values
  );

  return result.rows.map((row) => ({
    snapshot_id: row.snapshot_id,
    snapshot_date: String(row.snapshot_date),
    holding_account_id: row.holding_account_id!,
    holding_security_id: row.holding_security_id!,
    institution_price: row.institution_price != null ? Number(row.institution_price) : undefined,
    institution_value: row.institution_value != null ? Number(row.institution_value) : undefined,
    cost_basis: row.cost_basis != null ? Number(row.cost_basis) : undefined,
    quantity: row.quantity != null ? Number(row.quantity) : undefined,
  }));
};

/**
 * Gets the latest snapshot for each account.
 */
export const getLatestAccountSnapshots = async (
  user: MaskedUser
): Promise<AccountSnapshot[]> => {
  const result = await pool.query<SnapshotRow>(
    `SELECT DISTINCT ON (${ACCOUNT_ID})
            ${SNAPSHOT_ID}, ${SNAPSHOT_DATE}, ${ACCOUNT_ID},
            balances_available, balances_current, balances_limit, balances_iso_currency_code
     FROM ${SNAPSHOTS}
     WHERE ${USER_ID} = $1 AND ${SNAPSHOT_TYPE} = 'account_balance'
     AND (is_deleted IS NULL OR is_deleted = FALSE)
     ORDER BY ${ACCOUNT_ID}, ${SNAPSHOT_DATE} DESC`,
    [user.user_id]
  );

  return result.rows.map((row) => ({
    snapshot_id: row.snapshot_id,
    snapshot_date: String(row.snapshot_date),
    account_id: row.account_id!,
    balances_available: row.balances_available != null ? Number(row.balances_available) : undefined,
    balances_current: row.balances_current != null ? Number(row.balances_current) : undefined,
    balances_limit: row.balances_limit != null ? Number(row.balances_limit) : undefined,
    balances_iso_currency_code: row.balances_iso_currency_code,
  }));
};

/**
 * Upserts account snapshots.
 */
export const upsertAccountSnapshots = async (
  user: MaskedUser,
  snapshots: AccountSnapshot[]
): Promise<UpsertResult[]> => {
  if (!snapshots.length) return [];
  const results: UpsertResult[] = [];

  for (const snapshot of snapshots) {
    try {
      const result = await pool.query(
        `INSERT INTO ${SNAPSHOTS} (
          ${SNAPSHOT_ID}, ${USER_ID}, ${SNAPSHOT_DATE}, ${SNAPSHOT_TYPE}, ${ACCOUNT_ID},
          balances_available, balances_current, balances_limit, balances_iso_currency_code,
          updated
        ) VALUES ($1, $2, $3, 'account_balance', $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
        ON CONFLICT (${SNAPSHOT_ID}) DO UPDATE SET
          balances_available = COALESCE($5, ${SNAPSHOTS}.balances_available),
          balances_current = COALESCE($6, ${SNAPSHOTS}.balances_current),
          balances_limit = COALESCE($7, ${SNAPSHOTS}.balances_limit),
          balances_iso_currency_code = COALESCE($8, ${SNAPSHOTS}.balances_iso_currency_code),
          updated = CURRENT_TIMESTAMP
        RETURNING ${SNAPSHOT_ID}`,
        [
          snapshot.snapshot_id,
          user.user_id,
          snapshot.snapshot_date,
          snapshot.account_id,
          snapshot.balances_available,
          snapshot.balances_current,
          snapshot.balances_limit,
          snapshot.balances_iso_currency_code,
        ]
      );

      results.push(successResult(snapshot.snapshot_id, result.rowCount));
    } catch (error) {
      console.error("Failed to upsert account snapshot:", error);
      results.push(errorResult(snapshot.snapshot_id));
    }
  }

  return results;
};

/**
 * Upserts security snapshots.
 */
export const upsertSecuritySnapshots = async (
  snapshots: SecuritySnapshot[]
): Promise<UpsertResult[]> => {
  if (!snapshots.length) return [];
  const results: UpsertResult[] = [];

  for (const snapshot of snapshots) {
    try {
      const result = await pool.query(
        `INSERT INTO ${SNAPSHOTS} (
          ${SNAPSHOT_ID}, ${SNAPSHOT_DATE}, ${SNAPSHOT_TYPE}, ${SECURITY_ID}, close_price, updated
        ) VALUES ($1, $2, 'security', $3, $4, CURRENT_TIMESTAMP)
        ON CONFLICT (${SNAPSHOT_ID}) DO UPDATE SET
          close_price = COALESCE($4, ${SNAPSHOTS}.close_price),
          updated = CURRENT_TIMESTAMP
        RETURNING ${SNAPSHOT_ID}`,
        [snapshot.snapshot_id, snapshot.snapshot_date, snapshot.security_id, snapshot.close_price]
      );

      results.push(successResult(snapshot.snapshot_id, result.rowCount));
    } catch (error) {
      console.error("Failed to upsert security snapshot:", error);
      results.push(errorResult(snapshot.snapshot_id));
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
): Promise<UpsertResult[]> => {
  if (!snapshots.length) return [];
  const results: UpsertResult[] = [];

  for (const snapshot of snapshots) {
    try {
      const result = await pool.query(
        `INSERT INTO ${SNAPSHOTS} (
          ${SNAPSHOT_ID}, ${USER_ID}, ${SNAPSHOT_DATE}, ${SNAPSHOT_TYPE},
          holding_account_id, holding_security_id,
          institution_price, institution_value, cost_basis, quantity, updated
        ) VALUES ($1, $2, $3, 'holding', $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
        ON CONFLICT (${SNAPSHOT_ID}) DO UPDATE SET
          institution_price = COALESCE($6, ${SNAPSHOTS}.institution_price),
          institution_value = COALESCE($7, ${SNAPSHOTS}.institution_value),
          cost_basis = COALESCE($8, ${SNAPSHOTS}.cost_basis),
          quantity = COALESCE($9, ${SNAPSHOTS}.quantity),
          updated = CURRENT_TIMESTAMP
        RETURNING ${SNAPSHOT_ID}`,
        [
          snapshot.snapshot_id,
          user.user_id,
          snapshot.snapshot_date,
          snapshot.holding_account_id,
          snapshot.holding_security_id,
          snapshot.institution_price,
          snapshot.institution_value,
          snapshot.cost_basis,
          snapshot.quantity,
        ]
      );

      results.push(successResult(snapshot.snapshot_id, result.rowCount));
    } catch (error) {
      console.error("Failed to upsert holding snapshot:", error);
      results.push(errorResult(snapshot.snapshot_id));
    }
  }

  return results;
};

/**
 * Generic upsert that handles all snapshot types.
 */
export const upsertSnapshots = async (
  snapshots: JSONSnapshotData[]
): Promise<UpsertResult[]> => {
  if (!snapshots.length) return [];
  const results: UpsertResult[] = [];

  for (const snapshotData of snapshots) {
    const { snapshot } = snapshotData;
    if (!snapshot?.snapshot_id) continue;

    try {
      if (isAccountSnapshot(snapshotData)) {
        const { account } = snapshotData;
        await pool.query(
          `INSERT INTO ${SNAPSHOTS} (
            ${SNAPSHOT_ID}, ${USER_ID}, ${SNAPSHOT_DATE}, ${SNAPSHOT_TYPE}, ${ACCOUNT_ID},
            balances_available, balances_current, balances_limit, balances_iso_currency_code,
            updated
          ) VALUES ($1, $2, $3, 'account_balance', $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
          ON CONFLICT (${SNAPSHOT_ID}) DO UPDATE SET
            balances_available = COALESCE($5, ${SNAPSHOTS}.balances_available),
            balances_current = COALESCE($6, ${SNAPSHOTS}.balances_current),
            balances_limit = COALESCE($7, ${SNAPSHOTS}.balances_limit),
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
          ]
        );
      } else if (isSecuritySnapshot(snapshotData)) {
        const { security } = snapshotData;
        await pool.query(
          `INSERT INTO ${SNAPSHOTS} (
            ${SNAPSHOT_ID}, ${SNAPSHOT_DATE}, ${SNAPSHOT_TYPE}, ${SECURITY_ID}, close_price,
            updated
          ) VALUES ($1, $2, 'security', $3, $4, CURRENT_TIMESTAMP)
          ON CONFLICT (${SNAPSHOT_ID}) DO UPDATE SET
            close_price = COALESCE($4, ${SNAPSHOTS}.close_price),
            updated = CURRENT_TIMESTAMP`,
          [snapshot.snapshot_id, snapshot.date, security.security_id, security.close_price]
        );
      } else if (isHoldingSnapshot(snapshotData)) {
        const { holding } = snapshotData;
        await pool.query(
          `INSERT INTO ${SNAPSHOTS} (
            ${SNAPSHOT_ID}, ${USER_ID}, ${SNAPSHOT_DATE}, ${SNAPSHOT_TYPE},
            holding_account_id, holding_security_id,
            institution_price, institution_value, cost_basis, quantity,
            updated
          ) VALUES ($1, $2, $3, 'holding', $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
          ON CONFLICT (${SNAPSHOT_ID}) DO UPDATE SET
            institution_price = COALESCE($6, ${SNAPSHOTS}.institution_price),
            institution_value = COALESCE($7, ${SNAPSHOTS}.institution_value),
            cost_basis = COALESCE($8, ${SNAPSHOTS}.cost_basis),
            quantity = COALESCE($9, ${SNAPSHOTS}.quantity),
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
          ]
        );
      }

      results.push(successResult(snapshot.snapshot_id, 1));
    } catch (error) {
      console.error(`Failed to upsert snapshot ${snapshot.snapshot_id}:`, error);
      results.push(errorResult(snapshot.snapshot_id));
    }
  }

  return results;
};

/**
 * Deletes old snapshots.
 */
export const deleteOldSnapshots = async (
  beforeDate: string
): Promise<{ deleted: number }> => {
  const result = await pool.query(
    `UPDATE ${SNAPSHOTS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE ${SNAPSHOT_DATE} < $1
     AND (is_deleted IS NULL OR is_deleted = FALSE)
     RETURNING ${SNAPSHOT_ID}`,
    [beforeDate]
  );

  return { deleted: result.rowCount || 0 };
};

/**
 * Deletes snapshots by account ID.
 */
export const deleteSnapshotsByAccount = async (
  user: MaskedUser,
  account_id: string
): Promise<{ deleted: number }> => {
  const result = await pool.query(
    `UPDATE ${SNAPSHOTS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE ${ACCOUNT_ID} = $1 AND ${USER_ID} = $2
     AND (is_deleted IS NULL OR is_deleted = FALSE)
     RETURNING ${SNAPSHOT_ID}`,
    [account_id, user.user_id]
  );
  return { deleted: result.rowCount || 0 };
};

/**
 * Deletes all snapshots for a user.
 */
export const deleteSnapshotsByUser = async (
  user: MaskedUser
): Promise<{ deleted: number }> => {
  const result = await pool.query(
    `UPDATE ${SNAPSHOTS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE ${USER_ID} = $1
     AND (is_deleted IS NULL OR is_deleted = FALSE)
     RETURNING ${SNAPSHOT_ID}`,
    [user.user_id]
  );
  return { deleted: result.rowCount || 0 };
};

/**
 * Deletes a specific snapshot by ID.
 */
export const deleteSnapshotById = async (
  user: MaskedUser,
  snapshot_id: string
): Promise<boolean> => {
  const result = await pool.query(
    `UPDATE ${SNAPSHOTS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE ${SNAPSHOT_ID} = $1 AND ${USER_ID} = $2
     AND (is_deleted IS NULL OR is_deleted = FALSE)
     RETURNING ${SNAPSHOT_ID}`,
    [snapshot_id, user.user_id]
  );
  return (result.rowCount || 0) > 0;
};

/**
 * Aggregates account balance snapshots by date.
 */
export const aggregateAccountSnapshots = async (
  user: MaskedUser,
  options: {
    account_ids?: string[];
    startDate?: string;
    endDate?: string;
    interval?: "day" | "week" | "month";
  } = {}
): Promise<{ date: string; total_current: number; total_available: number }[]> => {
  const conditions: string[] = [
    `${USER_ID} = $1`,
    `${SNAPSHOT_TYPE} = 'account_balance'`,
    "(is_deleted IS NULL OR is_deleted = FALSE)",
  ];
  const values: string[] = [user.user_id];
  let paramIndex = 2;

  if (options.account_ids && options.account_ids.length > 0) {
    const placeholders = options.account_ids.map((_, i) => `$${paramIndex + i}`).join(", ");
    conditions.push(`${ACCOUNT_ID} IN (${placeholders})`);
    values.push(...options.account_ids);
    paramIndex += options.account_ids.length;
  }

  if (options.startDate) {
    conditions.push(`${SNAPSHOT_DATE} >= $${paramIndex++}`);
    values.push(options.startDate);
  }

  if (options.endDate) {
    conditions.push(`${SNAPSHOT_DATE} <= $${paramIndex++}`);
    values.push(options.endDate);
  }

  const interval = options.interval || "day";
  let dateGroup: string;
  switch (interval) {
    case "week":
      dateGroup = `date_trunc('week', ${SNAPSHOT_DATE})`;
      break;
    case "month":
      dateGroup = `date_trunc('month', ${SNAPSHOT_DATE})`;
      break;
    default:
      dateGroup = `date_trunc('day', ${SNAPSHOT_DATE})`;
  }

  const result = await pool.query<{
    date: string;
    total_current: string;
    total_available: string;
  }>(
    `SELECT ${dateGroup} as date,
            SUM(COALESCE(balances_current, 0)) as total_current,
            SUM(COALESCE(balances_available, 0)) as total_available
     FROM ${SNAPSHOTS}
     WHERE ${conditions.join(" AND ")}
     GROUP BY ${dateGroup}
     ORDER BY date`,
    values
  );

  return result.rows.map((row) => ({
    date: row.date,
    total_current: parseFloat(row.total_current) || 0,
    total_available: parseFloat(row.total_available) || 0,
  }));
};
