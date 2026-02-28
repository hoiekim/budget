import { JSONSnapshotData } from "common";
import { pool } from "../client";
import {
  MaskedUser,
  SnapshotModel,
  snapshotsTable,
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

const rowToSnapshot = (row: Record<string, unknown>): JSONSnapshotData =>
  new SnapshotModel(row).toJSON();

export const searchSnapshots = async (
  user: MaskedUser | null,
  options: SearchSnapshotsOptions = {},
): Promise<JSONSnapshotData[]> => {
  const { sql, values } = buildSelectWithFilters(SNAPSHOTS, "*", {
    user_id: user?.user_id,
    filters: {
      [SNAPSHOT_TYPE]: options.snapshot_type,
      [ACCOUNT_ID]: options.account_id,
      [SECURITY_ID]: options.security_id,
    },
    inFilters: options.account_ids?.length ? { [ACCOUNT_ID]: options.account_ids } : undefined,
    dateRange:
      options.startDate || options.endDate
        ? { column: SNAPSHOT_DATE, start: options.startDate, end: options.endDate }
        : undefined,
    orderBy: `${SNAPSHOT_DATE} DESC`,
    limit: options.limit,
  });
  const result = await pool.query<Record<string, unknown>>(sql, values);
  return result.rows.map(rowToSnapshot);
};

export const getAccountSnapshots = async (
  user: MaskedUser,
  options: { account_id?: string; startDate?: string; endDate?: string } = {},
): Promise<AccountSnapshot[]> => {
  const filters: Record<string, unknown> = {
    [USER_ID]: user.user_id,
    [SNAPSHOT_TYPE]: "account_balance",
  };
  if (options.account_id) filters[ACCOUNT_ID] = options.account_id;

  // Date range filtering requires raw query
  const { sql, values } = buildSelectWithFilters(SNAPSHOTS, "*", {
    user_id: user.user_id,
    filters: { [SNAPSHOT_TYPE]: "account_balance", [ACCOUNT_ID]: options.account_id },
    dateRange:
      options.startDate || options.endDate
        ? { column: SNAPSHOT_DATE, start: options.startDate, end: options.endDate }
        : undefined,
    orderBy: SNAPSHOT_DATE,
  });
  const result = await pool.query<Record<string, unknown>>(sql, values);

  return result.rows.map((row) => ({
    snapshot_id: row.snapshot_id as string,
    snapshot_date: String(row.snapshot_date),
    account_id: row.account_id as string,
    balances_available: row.balances_available != null ? Number(row.balances_available) : undefined,
    balances_current: row.balances_current != null ? Number(row.balances_current) : undefined,
    balances_limit: row.balances_limit != null ? Number(row.balances_limit) : undefined,
    balances_iso_currency_code: row.balances_iso_currency_code as string | undefined,
  }));
};

export const getSecuritySnapshots = async (
  options: { security_id?: string; startDate?: string; endDate?: string } = {},
): Promise<SecuritySnapshot[]> => {
  const { sql, values } = buildSelectWithFilters(SNAPSHOTS, "*", {
    filters: { [SNAPSHOT_TYPE]: "security", [SECURITY_ID]: options.security_id },
    dateRange:
      options.startDate || options.endDate
        ? { column: SNAPSHOT_DATE, start: options.startDate, end: options.endDate }
        : undefined,
    orderBy: SNAPSHOT_DATE,
  });
  const result = await pool.query<Record<string, unknown>>(sql, values);

  return result.rows.map((row) => ({
    snapshot_id: row.snapshot_id as string,
    snapshot_date: String(row.snapshot_date),
    security_id: row.security_id as string,
    close_price: row.close_price != null ? Number(row.close_price) : undefined,
  }));
};

export const getHoldingSnapshots = async (
  user: MaskedUser,
  options: { account_id?: string; security_id?: string; startDate?: string; endDate?: string } = {},
): Promise<HoldingSnapshot[]> => {
  const filters: Record<string, unknown> = { [SNAPSHOT_TYPE]: "holding" };
  if (options.account_id) filters.holding_account_id = options.account_id;
  if (options.security_id) filters.holding_security_id = options.security_id;

  const { sql, values } = buildSelectWithFilters(SNAPSHOTS, "*", {
    user_id: user.user_id,
    filters,
    dateRange:
      options.startDate || options.endDate
        ? { column: SNAPSHOT_DATE, start: options.startDate, end: options.endDate }
        : undefined,
    orderBy: SNAPSHOT_DATE,
  });
  const result = await pool.query<Record<string, unknown>>(sql, values);

  return result.rows.map((row) => ({
    snapshot_id: row.snapshot_id as string,
    snapshot_date: String(row.snapshot_date),
    holding_account_id: row.holding_account_id as string,
    holding_security_id: row.holding_security_id as string,
    institution_price: row.institution_price != null ? Number(row.institution_price) : undefined,
    institution_value: row.institution_value != null ? Number(row.institution_value) : undefined,
    cost_basis: row.cost_basis != null ? Number(row.cost_basis) : undefined,
    quantity: row.quantity != null ? Number(row.quantity) : undefined,
  }));
};

export const getLatestAccountSnapshots = async (user: MaskedUser): Promise<AccountSnapshot[]> => {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT DISTINCT ON (${ACCOUNT_ID}) ${SNAPSHOT_ID}, ${SNAPSHOT_DATE}, ${ACCOUNT_ID}, balances_available, balances_current, balances_limit, balances_iso_currency_code FROM ${SNAPSHOTS} WHERE ${USER_ID} = $1 AND ${SNAPSHOT_TYPE} = 'account_balance' AND (is_deleted IS NULL OR is_deleted = FALSE) ORDER BY ${ACCOUNT_ID}, ${SNAPSHOT_DATE} DESC`,
    [user.user_id],
  );
  return result.rows.map((row) => ({
    snapshot_id: row.snapshot_id as string,
    snapshot_date: String(row.snapshot_date),
    account_id: row.account_id as string,
    balances_available: row.balances_available != null ? Number(row.balances_available) : undefined,
    balances_current: row.balances_current != null ? Number(row.balances_current) : undefined,
    balances_limit: row.balances_limit != null ? Number(row.balances_limit) : undefined,
    balances_iso_currency_code: row.balances_iso_currency_code as string | undefined,
  }));
};

export const upsertAccountSnapshots = async (
  user: MaskedUser,
  snapshots: AccountSnapshot[],
): Promise<UpsertResult[]> => {
  if (!snapshots.length) return [];
  const results: UpsertResult[] = [];

  for (const snapshot of snapshots) {
    try {
      await snapshotsTable.upsert({
        [SNAPSHOT_ID]: snapshot.snapshot_id,
        [USER_ID]: user.user_id,
        [SNAPSHOT_DATE]: snapshot.snapshot_date,
        [SNAPSHOT_TYPE]: "account_balance",
        [ACCOUNT_ID]: snapshot.account_id,
        balances_available: snapshot.balances_available,
        balances_current: snapshot.balances_current,
        balances_limit: snapshot.balances_limit,
        balances_iso_currency_code: snapshot.balances_iso_currency_code,
      });
      results.push(successResult(snapshot.snapshot_id, 1));
    } catch (error) {
      console.error("Failed to upsert account snapshot:", error);
      results.push(errorResult(snapshot.snapshot_id));
    }
  }
  return results;
};

export const upsertSecuritySnapshots = async (
  snapshots: SecuritySnapshot[],
): Promise<UpsertResult[]> => {
  if (!snapshots.length) return [];
  const results: UpsertResult[] = [];

  for (const snapshot of snapshots) {
    try {
      await snapshotsTable.upsert({
        [SNAPSHOT_ID]: snapshot.snapshot_id,
        [SNAPSHOT_DATE]: snapshot.snapshot_date,
        [SNAPSHOT_TYPE]: "security",
        [SECURITY_ID]: snapshot.security_id,
        close_price: snapshot.close_price,
      });
      results.push(successResult(snapshot.snapshot_id, 1));
    } catch (error) {
      console.error("Failed to upsert security snapshot:", error);
      results.push(errorResult(snapshot.snapshot_id));
    }
  }
  return results;
};

export const upsertHoldingSnapshots = async (
  user: MaskedUser,
  snapshots: HoldingSnapshot[],
): Promise<UpsertResult[]> => {
  if (!snapshots.length) return [];
  const results: UpsertResult[] = [];

  for (const snapshot of snapshots) {
    try {
      await snapshotsTable.upsert({
        [SNAPSHOT_ID]: snapshot.snapshot_id,
        [USER_ID]: user.user_id,
        [SNAPSHOT_DATE]: snapshot.snapshot_date,
        [SNAPSHOT_TYPE]: "holding",
        holding_account_id: snapshot.holding_account_id,
        holding_security_id: snapshot.holding_security_id,
        institution_price: snapshot.institution_price,
        institution_value: snapshot.institution_value,
        cost_basis: snapshot.cost_basis,
        quantity: snapshot.quantity,
      });
      results.push(successResult(snapshot.snapshot_id, 1));
    } catch (error) {
      console.error("Failed to upsert holding snapshot:", error);
      results.push(errorResult(snapshot.snapshot_id));
    }
  }
  return results;
};

export const upsertSnapshots = async (snapshots: JSONSnapshotData[]): Promise<UpsertResult[]> => {
  if (!snapshots.length) return [];
  const results: UpsertResult[] = [];

  for (const snapshotData of snapshots) {
    const { snapshot } = snapshotData;
    if (!snapshot?.snapshot_id) continue;

    try {
      if (isAccountSnapshot(snapshotData)) {
        const { account } = snapshotData;
        await snapshotsTable.upsert({
          [SNAPSHOT_ID]: snapshot.snapshot_id,
          [USER_ID]: snapshotData.user?.user_id,
          [SNAPSHOT_DATE]: snapshot.date,
          [SNAPSHOT_TYPE]: "account_balance",
          [ACCOUNT_ID]: account.account_id,
          balances_available: account.balances?.available,
          balances_current: account.balances?.current,
          balances_limit: account.balances?.limit,
          balances_iso_currency_code: account.balances?.iso_currency_code,
        });
      } else if (isSecuritySnapshot(snapshotData)) {
        const { security } = snapshotData;
        await snapshotsTable.upsert({
          [SNAPSHOT_ID]: snapshot.snapshot_id,
          [SNAPSHOT_DATE]: snapshot.date,
          [SNAPSHOT_TYPE]: "security",
          [SECURITY_ID]: security.security_id,
          close_price: security.close_price,
        });
      } else if (isHoldingSnapshot(snapshotData)) {
        const { holding } = snapshotData;
        await snapshotsTable.upsert({
          [SNAPSHOT_ID]: snapshot.snapshot_id,
          [USER_ID]: snapshotData.user?.user_id,
          [SNAPSHOT_DATE]: snapshot.date,
          [SNAPSHOT_TYPE]: "holding",
          holding_account_id: holding.account_id,
          holding_security_id: holding.security_id,
          institution_price: holding.institution_price,
          institution_value: holding.institution_value,
          cost_basis: holding.cost_basis,
          quantity: holding.quantity,
        });
      }
      results.push(successResult(snapshot.snapshot_id, 1));
    } catch (error) {
      console.error(`Failed to upsert snapshot ${snapshot.snapshot_id}:`, error);
      results.push(errorResult(snapshot.snapshot_id));
    }
  }
  return results;
};

export const deleteOldSnapshots = async (beforeDate: string): Promise<{ deleted: number }> => {
  const result = await pool.query(
    `UPDATE ${SNAPSHOTS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE ${SNAPSHOT_DATE} < $1 AND (is_deleted IS NULL OR is_deleted = FALSE) RETURNING ${SNAPSHOT_ID}`,
    [beforeDate],
  );
  return { deleted: result.rowCount || 0 };
};

export const deleteSnapshotsByUser = async (user: MaskedUser): Promise<{ deleted: number }> => {
  const deleted = await snapshotsTable.bulkSoftDeleteByColumn(USER_ID, user.user_id);
  return { deleted };
};

export const deleteSnapshotById = async (
  user: MaskedUser,
  snapshot_id: string,
): Promise<boolean> => {
  return await snapshotsTable.softDelete(snapshot_id);
};

export const aggregateAccountSnapshots = async (
  user: MaskedUser,
  options: {
    account_ids?: string[];
    startDate?: string;
    endDate?: string;
    interval?: "day" | "week" | "month";
  } = {},
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
  const dateGroup =
    interval === "week"
      ? `date_trunc('week', ${SNAPSHOT_DATE})`
      : interval === "month"
        ? `date_trunc('month', ${SNAPSHOT_DATE})`
        : `date_trunc('day', ${SNAPSHOT_DATE})`;

  const result = await pool.query<{ date: string; total_current: string; total_available: string }>(
    `SELECT ${dateGroup} as date, SUM(COALESCE(balances_current, 0)) as total_current, SUM(COALESCE(balances_available, 0)) as total_available FROM ${SNAPSHOTS} WHERE ${conditions.join(" AND ")} GROUP BY ${dateGroup} ORDER BY date`,
    values,
  );
  return result.rows.map((row) => ({
    date: row.date,
    total_current: parseFloat(row.total_current) || 0,
    total_available: parseFloat(row.total_available) || 0,
  }));
};
