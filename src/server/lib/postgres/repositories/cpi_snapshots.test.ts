import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakePg, restoreLeaves } from "test-helpers";

const { pg, mockQuery, resetQueryMocks } = createFakePg();
mock.module("pg", () => pg);

const { getCpiSnapshots, upsertCpiSnapshots } = await import("./cpi_snapshots");
const { CpiSnapshotModel, getCpiSnapshotId } = await import("../models");

afterAll(restoreLeaves);

beforeEach(() => resetQueryMocks());

describe("CpiSnapshotModel", () => {
  test("keys a month by series and YYYY-MM so a re-fetch upserts the same row", () => {
    expect(getCpiSnapshotId("CUUR0000SA0", "2026-09-01")).toBe("CUUR0000SA0-2026-09");
    expect(
      CpiSnapshotModel.fromJSON({ series_id: "CUUR0000SA0", date: "2026-09-01", value: 324.5 }),
    ).toEqual({
      cpi_snapshot_id: "CUUR0000SA0-2026-09",
      series_id: "CUUR0000SA0",
      snapshot_date: "2026-09-01",
      index_value: 324.5,
    });
  });

  test("round-trips a row to JSON", () => {
    const model = new CpiSnapshotModel({
      cpi_snapshot_id: "CUUR0000SA0-2026-09",
      series_id: "CUUR0000SA0",
      snapshot_date: "2026-09-01",
      index_value: 324.5,
      updated: "2026-10-15T12:00:00+00:00",
    });
    expect(model.toJSON()).toEqual({
      series_id: "CUUR0000SA0",
      date: "2026-09-01",
      value: 324.5,
      updated: "2026-10-15T12:00:00+00:00",
    });
  });

  test("rejects a row whose value is not a number", () => {
    expect(
      () =>
        new CpiSnapshotModel({
          cpi_snapshot_id: "x",
          series_id: "CUUR0000SA0",
          snapshot_date: "2026-09-01",
          index_value: "324.5",
          updated: null,
        }),
    ).toThrow();
  });
});

describe("cpi_snapshots repository", () => {
  test("getCpiSnapshots filters by series and orders oldest first", async () => {
    mockQuery.mockImplementationOnce(async () => ({
      rows: [
        {
          cpi_snapshot_id: "CUUR0000SA0-2026-09",
          series_id: "CUUR0000SA0",
          snapshot_date: "2026-09-01",
          index_value: 324.5,
          updated: null,
        },
      ],
      rowCount: 1,
    }));
    const rows = await getCpiSnapshots("CUUR0000SA0");
    expect(rows).toEqual([
      { series_id: "CUUR0000SA0", date: "2026-09-01", value: 324.5, updated: null },
    ]);
    const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/SELECT \* FROM cpi_snapshots/);
    expect(sql).toMatch(/series_id = \$1/);
    expect(sql).toMatch(/ORDER BY snapshot_date ASC/);
    expect(sql).not.toMatch(/is_deleted/);
    expect(values).toEqual(["CUUR0000SA0"]);
  });

  test("upsertCpiSnapshots writes every month in one statement and re-stamps updated", async () => {
    mockQuery.mockImplementationOnce(async () => ({ rows: [{}, {}], rowCount: 2 }));
    const written = await upsertCpiSnapshots([
      { series_id: "CUUR0000SA0", date: "2026-08-01", value: 323.9 },
      { series_id: "CUUR0000SA0", date: "2026-09-01", value: 324.5 },
    ]);
    expect(written).toBe(2);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/INSERT INTO cpi_snapshots/);
    expect(sql).toMatch(/ON CONFLICT \(cpi_snapshot_id\) DO UPDATE SET .*index_value = EXCLUDED\.index_value/);
    expect(sql).toMatch(/updated = CURRENT_TIMESTAMP/);
  });

  test("upsertCpiSnapshots skips the round trip for an empty batch", async () => {
    expect(await upsertCpiSnapshots([])).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
