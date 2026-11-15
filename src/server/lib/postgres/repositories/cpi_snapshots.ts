import { JSONCpiSnapshot } from "common";
import { CpiSnapshotModel, cpiSnapshotsTable, SERIES_ID } from "../models";

/**
 * Every stored month of one CPI series, oldest first. The table holds a few
 * hundred rows per series at most (the refresh keeps a bounded window), so a
 * full read is cheaper than any incremental bookkeeping would be.
 */
export const getCpiSnapshots = async (series_id: string): Promise<JSONCpiSnapshot[]> => {
  const models = await cpiSnapshotsTable.query(
    { [SERIES_ID]: series_id },
    { orderBy: "snapshot_date ASC" },
  );
  return models.map((m) => m.toJSON());
};

/**
 * Upsert CPI months in one round trip. Each row's `updated` is reset to now,
 * including rows whose value did not change — the refresh cadence gate relies
 * on that to space out re-fetches while it waits for BLS to publish a month.
 * Returns the number of rows written.
 */
export const upsertCpiSnapshots = async (snapshots: JSONCpiSnapshot[]): Promise<number> => {
  if (!snapshots.length) return 0;
  const rows = snapshots.map((s) => CpiSnapshotModel.fromJSON(s));
  const written = await cpiSnapshotsTable.upsertMany(rows);
  return written.length;
};
