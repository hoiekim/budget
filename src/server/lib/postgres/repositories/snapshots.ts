import { JSONSnapshotData } from "common";
import {
  MaskedUser,
  SnapshotModel,
  snapshotsTable,
  isAccountSnapshot,
  isSecuritySnapshot,
  isHoldingSnapshot,
  SNAPSHOT_ID,
  SNAPSHOT_TYPE,
  SNAPSHOT_DATE,
  UPDATED,
  ACCOUNT_ID,
  HOLDING_ACCOUNT_ID,
  SECURITY_ID,
  HOLDING_SECURITY_ID,
  USER_ID,
  IS_DELETED,
} from "../models";
import { UpsertResult, successResult, errorResult } from "../database";
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
  /** When true, soft-deleted (`is_deleted = TRUE`) rows are INCLUDED in
   *  the response so the client can treat them as tombstones and
   *  evict them from its local cache (IDB + in-memory dict). Defaults
   *  to `false` for backward compatibility with consumers that expect
   *  active-only rows. */
  includeDeleted?: boolean;
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

// Security snapshots are price data — stored with `user_id = NULL` because
// they're shared across all users. The user-scoped query below would
// otherwise exclude them by the `user_id = $1` filter, leaving the frontend
// unable to resolve `security_id → ticker_symbol` (Closes #323).
//
// Two queries instead of one: `snapshotsTable.query` filters by a single
// `user_id`, so it can't express the `user_id = $1 OR user_id IS NULL` union
// that surfacing shared security rows alongside the user's own requires.
// Two scoped `.query` calls + concat is the smaller change.
export const searchSnapshots = async (
  user: MaskedUser | null,
  options: SearchSnapshotsOptions = {},
): Promise<JSONSnapshotData[]> => {
  // Filter by `updated`, not `snapshot_date` — matches the transactions
  // repository (`{ column: UPDATED, ... }`). Soft-deletes and edits bump
  // `updated`, so the FE's delta-by-cursor sync surfaces them regardless
  // of which month the snapshot is originally dated to. Filtering on
  // `snapshot_date` would never include a snapshot whose row moved
  // (deletion / re-dating) but whose original date is outside the
  // cursor's window.
  const dateRange =
    options.startDate || options.endDate
      ? { column: UPDATED, start: options.startDate, end: options.endDate }
      : undefined;

  const userSnapshots = await snapshotsTable.query(
    {
      [SNAPSHOT_TYPE]: options.snapshot_type,
      [ACCOUNT_ID]: options.account_id,
      [SECURITY_ID]: options.security_id,
    },
    {
      user_id: user?.user_id,
      inFilters: options.account_ids?.length ? { [ACCOUNT_ID]: options.account_ids } : undefined,
      dateRange,
      orderBy: `${SNAPSHOT_DATE} DESC`,
      limit: options.limit,
      excludeDeleted: !options.includeDeleted,
    },
  );

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
  const holdingByAccountSnapshots: SnapshotModel[] = [];
  if (wantsHoldingByAccount) {
    const holdingSnapshots = await snapshotsTable.query(
      {
        [SNAPSHOT_TYPE]: "holding",
        [HOLDING_ACCOUNT_ID]: options.account_id,
        // Holding rows store the security in `holding_security_id`; the
        // `security_id` column is NULL for them. Filtering by `SECURITY_ID`
        // here would match zero rows (latent for any future caller that
        // passes both `account_id` and `security_id`).
        [HOLDING_SECURITY_ID]: options.security_id,
      },
      {
        user_id: user?.user_id,
        inFilters: options.account_ids?.length
          ? { [HOLDING_ACCOUNT_ID]: options.account_ids }
          : undefined,
        dateRange,
        orderBy: `${SNAPSHOT_DATE} DESC`,
        limit: options.limit,
        excludeDeleted: !options.includeDeleted,
      },
    );
    holdingByAccountSnapshots.push(...holdingSnapshots);
  }

  // Security snapshots only make sense when the caller isn't narrowing to a
  // specific account or a non-security snapshot_type. Skip the second query
  // in those cases to keep the response shape consistent with the request.
  const wantsSecurity =
    (!options.snapshot_type || options.snapshot_type === "security") &&
    !options.account_id &&
    !options.account_ids?.length;
  if (!wantsSecurity) {
    return [...userSnapshots, ...holdingByAccountSnapshots].map((s) => s.toJSON());
  }

  const securitySnapshots = await snapshotsTable.query(
    {
      [SNAPSHOT_TYPE]: "security",
      [SECURITY_ID]: options.security_id,
    },
    {
      dateRange,
      orderBy: `${SNAPSHOT_DATE} DESC`,
      limit: options.limit,
      excludeDeleted: !options.includeDeleted,
    },
  );

  // Enrich each security snapshot with ticker_symbol / name / type from the
  // securities table. Without this the frontend's `securitySnapshots` dict
  // would carry only `{ security_id, close_price }` and `HoldingsComposition`
  // still couldn't resolve `security_id → ticker`. Same enrichment pattern
  // as `getHoldingSnapshotsRoute`.
  const uniqueSecurityIds = [
    ...new Set(securitySnapshots.map((s) => s.security_id as string).filter(Boolean)),
  ];
  const securities = uniqueSecurityIds.length ? await searchSecuritiesById(uniqueSecurityIds) : [];
  const securityMap = new Map(securities.map((s) => [s.security_id, s]));

  const enrichedSecuritySnapshots = securitySnapshots.map((model) => {
    const snap = model.toJSON();
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
    ...userSnapshots.map((s) => s.toJSON()),
    ...holdingByAccountSnapshots.map((s) => s.toJSON()),
    ...enrichedSecuritySnapshots,
  ];
};

export const getSecuritySnapshots = async (
  options: { security_id?: string; startDate?: string; endDate?: string } = {},
): Promise<SecuritySnapshot[]> => {
  const snapshots = await snapshotsTable.query(
    { [SNAPSHOT_TYPE]: "security", [SECURITY_ID]: options.security_id },
    {
      dateRange:
        options.startDate || options.endDate
          ? { column: SNAPSHOT_DATE, start: options.startDate, end: options.endDate }
          : undefined,
      orderBy: SNAPSHOT_DATE,
    },
  );

  return snapshots.map((s) => ({
    snapshot_id: s.snapshot_id,
    snapshot_date: String(s.snapshot_date),
    security_id: s.security_id as string,
    close_price: s.close_price != null ? Number(s.close_price) : undefined,
  }));
};

export const getHoldingSnapshots = async (
  user: MaskedUser,
  options: { account_id?: string; security_id?: string; startDate?: string; endDate?: string } = {},
): Promise<HoldingSnapshot[]> => {
  const filters: Record<string, unknown> = { [SNAPSHOT_TYPE]: "holding" };
  if (options.account_id) filters.holding_account_id = options.account_id;
  if (options.security_id) filters.holding_security_id = options.security_id;

  const snapshots = await snapshotsTable.query(filters, {
    user_id: user.user_id,
    dateRange:
      options.startDate || options.endDate
        ? { column: SNAPSHOT_DATE, start: options.startDate, end: options.endDate }
        : undefined,
    orderBy: SNAPSHOT_DATE,
  });

  return snapshots.map((s) => ({
    snapshot_id: s.snapshot_id,
    snapshot_date: String(s.snapshot_date),
    holding_account_id: s.holding_account_id as string,
    holding_security_id: s.holding_security_id as string,
    institution_price: s.institution_price != null ? Number(s.institution_price) : undefined,
    institution_value: s.institution_value != null ? Number(s.institution_value) : undefined,
    cost_basis: s.cost_basis != null ? Number(s.cost_basis) : undefined,
    quantity: s.quantity != null ? Number(s.quantity) : undefined,
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
        [IS_DELETED]: false,
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
          // Deletes are soft, so a re-add (or a date edit) that lands on a
          // previously deleted day updates the tombstoned row. Without this the
          // row keeps `is_deleted = TRUE`, the write "succeeds", and the next
          // delta sync reads it back as a tombstone and evicts it again.
          [IS_DELETED]: false,
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
          [IS_DELETED]: false,
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

export const deleteSnapshotById = async (
  user: MaskedUser,
  snapshot_id: string,
): Promise<boolean> => {
  return await snapshotsTable.softDelete(snapshot_id, user.user_id);
};

