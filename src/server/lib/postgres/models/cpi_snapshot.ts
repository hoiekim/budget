import { JSONCpiSnapshot, isString, isNumber, isNullableString } from "common";
import { CPI_SNAPSHOTS } from "common/constants";
import { CPI_SNAPSHOT_ID, SERIES_ID, SNAPSHOT_DATE, INDEX_VALUE, UPDATED } from "./common";

import { Model, RowValueType, createTable } from "./base";

/**
 * Monthly Consumer Price Index observations pulled from the BLS API by the
 * scheduled refresh (`compute-tools/refresh-cpi-snapshots.ts`). Global data —
 * no `user_id` — so every user's projection chart averages the same series.
 *
 * Kept out of the `snapshots` table on purpose: that table's rows are
 * user-scoped (or keyed to a held security) and stream to the client through
 * `GET /api/snapshots`, whose JSON union has no member for a price index.
 *
 * The primary key is `${series_id}-${YYYY-MM}`, so re-fetching a month
 * upserts the same row and bumps `updated`, which is what the refresh
 * cadence gate reads.
 */
const cpiSnapshotSchema = {
  [CPI_SNAPSHOT_ID]: "VARCHAR(255) PRIMARY KEY",
  [SERIES_ID]: "VARCHAR(50) NOT NULL",
  [SNAPSHOT_DATE]: "DATE NOT NULL",
  [INDEX_VALUE]: "DECIMAL(15, 6) NOT NULL",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
};

type CpiSnapshotSchema = typeof cpiSnapshotSchema;
type CpiSnapshotRow = { [k in keyof CpiSnapshotSchema]: RowValueType };

export const getCpiSnapshotId = (series_id: string, date: string): string =>
  `${series_id}-${date.slice(0, 7)}`;

export class CpiSnapshotModel
  extends Model<JSONCpiSnapshot, CpiSnapshotSchema>
  implements CpiSnapshotRow
{
  declare cpi_snapshot_id: string;
  declare series_id: string;
  declare snapshot_date: string;
  declare index_value: number;
  declare updated: string | null;

  static typeChecker = {
    cpi_snapshot_id: isString,
    series_id: isString,
    snapshot_date: isString,
    index_value: isNumber,
    updated: isNullableString,
  };

  constructor(data: unknown) {
    super(data, CpiSnapshotModel.typeChecker);
  }

  toJSON(): JSONCpiSnapshot {
    return {
      series_id: this.series_id,
      date: this.snapshot_date,
      value: this.index_value,
      updated: this.updated,
    };
  }

  static fromJSON(s: JSONCpiSnapshot): Partial<CpiSnapshotRow> {
    return {
      cpi_snapshot_id: getCpiSnapshotId(s.series_id, s.date),
      series_id: s.series_id,
      snapshot_date: s.date,
      index_value: s.value,
    };
  }
}

export const cpiSnapshotsTable = createTable({
  name: CPI_SNAPSHOTS,
  primaryKey: CPI_SNAPSHOT_ID,
  schema: cpiSnapshotSchema,
  indexes: [{ column: SERIES_ID }],
  ModelClass: CpiSnapshotModel,
  supportsSoftDelete: false,
});

export const cpiSnapshotColumns = Object.keys(cpiSnapshotsTable.schema);
