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
  HOLDING_ACCOUNT_ID,
  SECURITY_ID,
  HOLDING_SECURITY_ID,
  USER_ID,
} from "../models";
import { UpsertResult, successResult, errorResult, buildSelectWithFilters } from "../database";
import { searchSecuritiesById } from "./securities";
import { logger } from "../../logger";

export interface SearchSnapshotsOptions {
  account_id?: string;
  account_ids?: string[];
  security_id?: string;
  snapshot_type?: "account_balance" | "security" | "holding";
  startDate?: string;
  endDate?: string;
  limit?: number;
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

// Security snapshots are price data — stored with `user_id = NULL` because
// they're shared across all users. The user-scoped query below would
// otherwise exclude them by the `user_id = $1` filter, leaving the frontend
// unable to resolve `security_id → ticker_symbol` (Closes #323).
//
// Two queries instead of one: the user-scoped table-helper path doesn't
// support an OR predicate, and a raw SQL rewrite of the whole search would
// duplicate the date-range / inFilters logic that `buildSelectWithFilters`
// already encodes. Two helper calls + concat is the smaller change.
export const searchSnapshots = async (
  user: MaskedUser | null,
  options: SearchSnapshotsOptions = {},
): Promise<JSONSnapshotData[]> => {
  const dateRange =
    options.startDate || options.endDate
      ? { column: SNAPSHOT_DATE, start: options.startDate, end: options.endDate }
      : undefined;

  const userScoped = buildSelectWithFilters(SNAPSHOTS, "*", {
    user_id: user?.user_id,
    filters: {
      [SNAPSHOT_TYPE]: options.snapshot_type,
      [ACCOUNT_ID]: options.account_id,
      [SECURITY_ID]: options.security_id,
    },
    inFilters: options.account_ids?.length ? { [ACCOUNT_ID]: options.account_ids } : undefined,
    dateRange,
    orderBy: `${SNAPSHOT_DATE} DESC`,
    limit: options.limit,
  });
  const userResult = await pool.query<Record<string, unknown>>(userScoped.sql, userScoped.values);

  // Holding snapshots store the account in `holding_account_id` and leave
  // `account_id` NULL — so the `account_id`-filtered query above never
  // returns them. When the caller narrows by account (single or list) AND
  // the requested type is `holding` or unspecified, run a second query
  // keyed on `holding_account_id` and union the results. Mirrors how the
  // security-snapshot branch below works around the same single-table-
  // multiple-row-shapes problem.
  //
  // Without this branch, `data.holdingSnapshots` is empty for every
  // user (sync.ts calls /api/snapshots per-account, month-sliced —
  // post-PR #364), which silently breaks Holdings Composition,
  // Investment Performance MWR's snapshot anchor, and the holding-snap
  // balance fallback. See #445.
  const wantsHoldingByAccount =
    (!options.snapshot_type || options.snapshot_type === "holding") &&
    (options.account_id || options.account_ids?.length);
  const holdingByAccountRows: Record<string, unknown>[] = [];
  if (wantsHoldingByAccount) {
    const holdingScoped = buildSelectWithFilters(SNAPSHOTS, "*", {
      user_id: user?.user_id,
      filters: {
        [SNAPSHOT_TYPE]: "holding",
        [HOLDING_ACCOUNT_ID]: options.account_id,
        // Holding rows store the security in `holding_security_id`; the
        // `security_id` column is NULL for them. Filtering by `SECURITY_ID`
        // here would match zero rows (latent for any future caller that
        // passes both `account_id` and `security_id`).
        [HOLDING_SECURITY_ID]: options.security_id,
      },
      inFilters: options.account_ids?.length
        ? { [HOLDING_ACCOUNT_ID]: options.account_ids }
        : undefined,
      dateRange,
      orderBy: `${SNAPSHOT_DATE} DESC`,
      limit: options.limit,
    });
    const holdingResult = await pool.query<Record<string, unknown>>(
      holdingScoped.sql,
      holdingScoped.values,
    );
    holdingByAccountRows.push(...holdingResult.rows);
  }

  // Security snapshots only make sense when the caller isn't narrowing to a
  // specific account or a non-security snapshot_type. Skip the second query
  // in those cases to keep the response shape consistent with the request.
  const wantsSecurity =
    (!options.snapshot_type || options.snapshot_type === "security") &&
    !options.account_id &&
    !options.account_ids?.length;
  if (!wantsSecurity) {
    return [...userResult.rows, ...holdingByAccountRows].map(rowToSnapshot);
  }

  const globalSecurity = buildSelectWithFilters(SNAPSHOTS, "*", {
    filters: {
      [SNAPSHOT_TYPE]: "security",
      [SECURITY_ID]: options.security_id,
    },
    dateRange,
    orderBy: `${SNAPSHOT_DATE} DESC`,
    limit: options.limit,
  });
  const securityResult = await pool.query<Record<string, unknown>>(
    globalSecurity.sql,
    globalSecurity.values,
  );

  // Enrich each security snapshot with ticker_symbol / name / type from the
  // securities table. Without this the frontend's `securitySnapshots` dict
  // would carry only `{ security_id, close_price }` and `HoldingsComposition`
  // still couldn't resolve `security_id → ticker`. Same enrichment pattern
  // as `getHoldingSnapshotsRoute`.
  const uniqueSecurityIds = [
    ...new Set(securityResult.rows.map((r) => r.security_id as string).filter(Boolean)),
  ];
  const securities = uniqueSecurityIds.length ? await searchSecuritiesById(uniqueSecurityIds) : [];
  const securityMap = new Map(securities.map((s) => [s.security_id, s]));

  const enrichedSecuritySnapshots = securityResult.rows.map((row) => {
    const snap = rowToSnapshot(row);
    if (!isSecuritySnapshot(snap)) return snap;
    const sec = securityMap.get(snap.security.security_id);
    if (sec) {
      // Spread the full security record first, then keep the snapshot's
      // historical `close_price` (per snapshot_date) — the securities table
      // only holds the latest price.
      snap.security = { ...sec, close_price: snap.security.close_price };
    }
    return snap;
  });

  return [
    ...userResult.rows.map(rowToSnapshot),
    ...holdingByAccountRows.map(rowToSnapshot),
    ...enrichedSecuritySnapshots,
  ];
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
      logger.error("Failed to upsert holding snapshot", { snapshotId: snapshot.snapshot_id }, error);
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
      logger.error("Failed to upsert snapshot", { snapshotId: snapshot.snapshot_id }, error);
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
  return await snapshotsTable.softDelete(snapshot_id, user.user_id);
};

