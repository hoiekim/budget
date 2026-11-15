import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";
import type { JSONCpiSnapshot } from "common";

let storedRows: Array<Record<string, unknown>> = [];
const { driver, mockUnsafe, clearSqlMocks } = createFakeSql(async (sql: string) => {
  if (/FROM\s+cpi_snapshots/i.test(sql)) return { rows: storedRows, rowCount: storedRows.length };
  return { rows: [], rowCount: 0 };
});
mock.module("./postgres/sql-driver", () => driver);

const {
  computeAverageInflation,
  getAverageInflation,
  toMonthIndex,
  fromMonthIndex,
  INFLATION_AVERAGE_YEARS,
} = await import("./inflation");

afterAll(restoreLeaves);

beforeEach(() => {
  clearSqlMocks();
  storedRows = [];
});

const cpi = (date: string, value: number, series_id = "CUUR0000SA0"): JSONCpiSnapshot => ({
  series_id,
  date,
  value,
});

describe("month index helpers", () => {
  test("round-trip a YYYY-MM-DD date through its month index", () => {
    expect(fromMonthIndex(toMonthIndex("2026-09-01"))).toBe("2026-09");
    expect(fromMonthIndex(toMonthIndex("1996-12"))).toBe("1996-12");
    expect(toMonthIndex("2026-01-01") - toMonthIndex("2025-12-01")).toBe(1);
  });
});

describe("computeAverageInflation", () => {
  test("is the compound annual rate between the window's first and last month", () => {
    // Index doubles over exactly 30 years → 2^(1/30) per year.
    const result = computeAverageInflation([cpi("1996-09-01", 150), cpi("2026-09-01", 300)], 30);
    expect(result).not.toBeNull();
    expect(result!.year_over_year_inflation).toBeCloseTo(Math.pow(2, 1 / 30), 12);
    expect(result!.from).toBe("1996-09");
    expect(result!.to).toBe("2026-09");
    expect(result!.series_id).toBe("CUUR0000SA0");
  });

  test("ignores months older than the window", () => {
    const result = computeAverageInflation(
      [cpi("1980-01-01", 50), cpi("2016-09-01", 200), cpi("2026-09-01", 220)],
      10,
    );
    expect(result!.from).toBe("2016-09");
    expect(result!.year_over_year_inflation).toBeCloseTo(Math.pow(1.1, 1 / 10), 12);
  });

  test("annualizes over the real span when the base month is missing", () => {
    // 2016-09 is absent, so the base is 2016-10: 119 months, not 120.
    const result = computeAverageInflation(
      [cpi("2016-10-01", 200), cpi("2020-01-01", 210), cpi("2026-09-01", 240)],
      10,
    );
    expect(result!.from).toBe("2016-10");
    expect(result!.year_over_year_inflation).toBeCloseTo(Math.pow(1.2, 12 / 119), 12);
  });

  test("uses whatever history exists while the backfill is still short of the window", () => {
    const result = computeAverageInflation([cpi("2024-09-01", 300), cpi("2026-09-01", 318)]);
    expect(result!.from).toBe("2024-09");
    expect(result!.year_over_year_inflation).toBeCloseTo(Math.sqrt(1.06), 12);
  });

  test("sorts input and skips unusable values", () => {
    const result = computeAverageInflation(
      [cpi("2026-09-01", 220), cpi("2025-09-01", 0), cpi("bad", 5), cpi("2016-09-01", 200)],
      10,
    );
    expect(result!.from).toBe("2016-09");
    expect(result!.to).toBe("2026-09");
  });

  test("returns null with less than a year of history", () => {
    expect(computeAverageInflation([])).toBeNull();
    expect(computeAverageInflation([cpi("2026-09-01", 300)])).toBeNull();
    expect(computeAverageInflation([cpi("2026-01-01", 300), cpi("2026-09-01", 303)])).toBeNull();
  });

  test("defaults to the configured window", () => {
    const old = cpi(`${2026 - INFLATION_AVERAGE_YEARS - 5}-09-01`, 100);
    const base = cpi(`${2026 - INFLATION_AVERAGE_YEARS}-09-01`, 150);
    const result = computeAverageInflation([old, base, cpi("2026-09-01", 300)]);
    expect(result!.from).toBe(base.date.slice(0, 7));
  });
});

describe("getAverageInflation", () => {
  test("reads the stored CPI-U series and averages it", async () => {
    storedRows = [
      { cpi_snapshot_id: "CUUR0000SA0-2016-09", series_id: "CUUR0000SA0", snapshot_date: "2016-09-01", index_value: 200, updated: null },
      { cpi_snapshot_id: "CUUR0000SA0-2026-09", series_id: "CUUR0000SA0", snapshot_date: "2026-09-01", index_value: 260, updated: null },
    ];
    const result = await getAverageInflation();

    expect(result!.year_over_year_inflation).toBeCloseTo(Math.pow(1.3, 1 / 10), 12);
    const [sql, values] = mockUnsafe.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/FROM cpi_snapshots/);
    expect(sql).toMatch(/ORDER BY snapshot_date ASC/);
    expect(values).toContain("CUUR0000SA0");
  });

  test("is null before anything has been stored", async () => {
    expect(await getAverageInflation()).toBeNull();
  });
});
