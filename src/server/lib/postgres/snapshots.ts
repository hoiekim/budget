import {
  JSONSnapshotData,
  DeepPartial,
  JSONSnapshot,
  JSONAccount,
  JSONHolding,
  JSONSecurity,
} from "common";
import { pool } from "./client";
import { MaskedUser } from "./users";
import { RemovedAccount } from "./accounts";

export interface SearchSnapshotsOptions {
  range?: DateRange;
  query?: DeepPartial<JSONSnapshotData>;
}

interface DateRange {
  start: Date;
  end: Date;
}

export const searchSnapshots = async (user?: MaskedUser, options?: SearchSnapshotsOptions) => {
  const { range, query } = options || {};
  if (!user && !query) return [];
  const { start, end } = range || {};
  const isValidRange = start && end && start < end;

  let conditions: string[] = [];
  let values: any[] = [];
  let paramIndex = 1;

  if (user) {
    conditions.push(`user_id = $${paramIndex++}`);
    values.push(user.user_id);
  }

  if (isValidRange) {
    conditions.push(`updated >= $${paramIndex++}`);
    values.push(start.toISOString());
    conditions.push(`updated < $${paramIndex++}`);
    values.push(end.toISOString());
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await pool.query<{
    snapshot_id: string;
    user_id: string | null;
    snapshot_date: string;
    snapshot_type: string;
    data: any;
  }>(
    `SELECT snapshot_id, user_id, snapshot_date, snapshot_type, data FROM snapshots ${whereClause}`,
    values
  );

  const snapshots: JSONSnapshotData[] = [];

  result.rows.forEach((row) => {
    const snapshot: JSONSnapshot = {
      snapshot_id: row.snapshot_id,
      date: row.snapshot_date,
    };

    if (row.snapshot_type === "account" && row.user_id) {
      snapshots.push({
        snapshot,
        user: { user_id: row.user_id },
        account: row.data,
      });
    } else if (row.snapshot_type === "holding" && row.user_id) {
      snapshots.push({
        snapshot,
        user: { user_id: row.user_id },
        holding: row.data,
      });
    } else if (row.snapshot_type === "security") {
      snapshots.push({
        snapshot,
        security: row.data,
      });
    }
  });

  return snapshots;
};

export type PartialSnapshot = Partial<JSONSnapshot> & { snapshot_id: string };
export interface PartialAccountSnapshot {
  snapshot: PartialSnapshot;
  user: { user_id: string };
  account: Partial<JSONAccount>;
}
export interface PartialHoldingSnapshot {
  snapshot: PartialSnapshot;
  user: { user_id: string };
  holding: Partial<JSONHolding>;
}
export interface PartialSecuritySnapshot {
  snapshot: PartialSnapshot;
  security: Partial<JSONSecurity>;
}
export type PartialSnapshotData =
  | PartialAccountSnapshot
  | PartialHoldingSnapshot
  | PartialSecuritySnapshot;

export const upsertSnapshots = async (docs: PartialSnapshotData[], upsert: boolean = true) => {
  if (!docs.length) return [];
  const results: { update: { _id: string }; status: number }[] = [];
  const updated = new Date().toISOString();

  for (const doc of docs) {
    const { snapshot_id, date } = doc.snapshot;
    let snapshot_type: string;
    let data: any;
    let user_id: string | null = null;

    if ("account" in doc) {
      snapshot_type = "account";
      data = doc.account;
      user_id = doc.user.user_id;
    } else if ("holding" in doc) {
      snapshot_type = "holding";
      data = doc.holding;
      user_id = doc.user.user_id;
    } else if ("security" in doc) {
      snapshot_type = "security";
      data = doc.security;
    } else {
      continue;
    }

    if (upsert) {
      const result = await pool.query(
        `INSERT INTO snapshots (snapshot_id, user_id, snapshot_date, snapshot_type, data, updated)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (snapshot_id) DO UPDATE SET
           snapshot_date = COALESCE($3, snapshots.snapshot_date),
           data = snapshots.data || $5,
           updated = $6
         RETURNING snapshot_id`,
        [snapshot_id, user_id, date, snapshot_type, JSON.stringify(data), updated]
      );
      results.push({ update: { _id: snapshot_id }, status: result.rowCount ? 200 : 404 });
    } else {
      const result = await pool.query(
        `UPDATE snapshots SET
           snapshot_date = COALESCE($3, snapshot_date),
           data = data || $5,
           updated = $6
         WHERE snapshot_id = $1
         RETURNING snapshot_id`,
        [snapshot_id, user_id, date, snapshot_type, JSON.stringify(data), updated]
      );
      results.push({ update: { _id: snapshot_id }, status: result.rowCount ? 200 : 404 });
    }
  }

  return results;
};

export interface RemovedSnapshot {
  snapshot_id: string;
}

export const deleteSnapshots = async (docs: { snapshot: RemovedSnapshot }[]) => {
  if (!Array.isArray(docs) || !docs.length) return;

  const snapshotIds = docs.map((e) => e.snapshot.snapshot_id);

  const result = await pool.query(
    `DELETE FROM snapshots WHERE snapshot_id = ANY($1)`,
    [snapshotIds]
  );

  return { deleted: result.rowCount };
};

export const deleteSnapshotsByUser = async (
  user: MaskedUser,
  docs: { snapshot: RemovedSnapshot }[]
) => {
  if (!Array.isArray(docs) || !docs.length) return;
  const { user_id } = user;

  const snapshotIds = docs.map((e) => e.snapshot.snapshot_id);

  const result = await pool.query(
    `DELETE FROM snapshots WHERE user_id = $1 AND snapshot_id = ANY($2)`,
    [user_id, snapshotIds]
  );

  return { deleted: result.rowCount };
};

export const deleteSnapshotsByAccount = async (
  user: MaskedUser,
  docs: { account: RemovedAccount }[]
) => {
  if (!Array.isArray(docs) || !docs.length) return;
  const { user_id } = user;

  const accountIds = docs.map((e) => e.account.account_id);

  const result = await pool.query(
    `DELETE FROM snapshots 
     WHERE user_id = $1 
     AND snapshot_type = 'account' 
     AND data->>'account_id' = ANY($2)`,
    [user_id, accountIds]
  );

  return { deleted: result.rowCount };
};
