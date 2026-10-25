// Behavior pins for the Bun.sql driver surface in ./client. These are the
// pg pins from PR #987, rewritten for the new driver — the OBSERVABLE
// contract is unchanged, only the mechanism moved:
//
// - the client is constructed with the production settings (max, idle and
//   connection timeouts, mapped from pg's milliseconds to Bun.sql seconds),
// - the result conversion shapes values exactly the way callers consume
//   them (NUMERIC/INT8 as floats, DATE as a raw string, TIMESTAMPTZ as an
//   ISO string, JSON/JSONB as parsed objects), with every other type
//   passing through untouched,
// - withTransaction's BEGIN/COMMIT/ROLLBACK/release sequencing, including
//   that the ORIGINAL error propagates after a rollback.
//
// What changed vs the pg pins, and why:
// - Pool construction options replace pg's PoolConfig: `max` stays 20,
//   `idleTimeoutMillis: 30000` becomes `idleTimeout: 30` (seconds),
//   `connectionTimeoutMillis: 2000` becomes `connectionTimeout: 2`.
// - The custom type-parser set is gone — Bun.sql has no per-type parser
//   hooks. The same shapes are produced by the OID-keyed conversion layer
//   in ./client, so these tests script Bun-shaped results (arrays with
//   `count`/`columns`, including the column OIDs) and assert the converted
//   rows, instead of calling a parser function directly.
// - TIMESTAMPTZ converts to `toISOString()` (`Z`, milliseconds included)
//   rather than pg's `+HH:MM` offset form: Bun.sql hands the adapter a
//   Date, and the original offset is unrecoverable from it. Same instant,
//   canonical text — every consumer parses it with `new Date(...)`.
// - withTransaction now runs on a reserved connection (`reserve()`), not
//   `pool.connect()`; the statement sequences are identical.
//
// CI has no Postgres service (see .github/workflows/ci.yml), so these run
// against the shared createFakeSql stub (see scripts/test-helpers.ts). The
// type expectations were validated against real Bun.sql output on a live
// server before this migration landed.
import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";

const { driver, mockUnsafe, mockReservedUnsafe, mockRelease, constructedOptions } =
  createFakeSql();

mock.module("./sql-driver", () => driver);

const { pool, resetPool, withTransaction } = await import("./client");

afterAll(restoreLeaves);

beforeEach(() => {
  mockUnsafe.mockClear();
  mockReservedUnsafe.mockClear();
  mockRelease.mockClear();
  mockUnsafe.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
  mockReservedUnsafe.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
  resetPool();
});

// PostgreSQL type OIDs, as Bun.sql reports them in result.columns.
const NUMERIC = 1700;
const INT8 = 20;
const DATE = 1082;
const TIMESTAMPTZ = 1184;
const JSON = 114;
const JSONB = 3802;
const INT4 = 23;
const BOOL = 16;
const TEXT = 25;

// A Bun-shaped result: rows plus count/columns metadata.
const bunResult = (
  rows: Record<string, unknown>[],
  columns: { name: string; type: number }[],
) => Object.assign([...rows], { count: rows.length, columns });

const clientOptions = async () => {
  await pool.query("SELECT 1");
  return constructedOptions.at(-1) as {
    max: number;
    idleTimeout: number;
    connectionTimeout: number;
    onclose: unknown;
  };
};

describe("client construction", () => {
  test("uses the production pool settings, timeouts in seconds", async () => {
    const options = await clientOptions();
    expect(options.max).toBe(20);
    expect(options.idleTimeout).toBe(30);
    expect(options.connectionTimeout).toBe(2);
  });

  test("wires a connection-close handler at construction", async () => {
    expect(typeof (await clientOptions()).onclose).toBe("function");
  });
});

describe("result conversion", () => {
  // Bun.sql returns NUMERIC/INT8 as strings; the repo consumes floats (not
  // strings, not BigInt). INT8 rounding for values past 2^53 is preserved,
  // not "fixed".
  test("NUMERIC converts to a float", async () => {
    mockUnsafe.mockResolvedValueOnce(
      bunResult([{ n: "19.99" }, { n: "-0.5" }, { n: "0" }], [{ name: "n", type: NUMERIC }]),
    );
    const { rows } = await pool.query("SELECT 1");
    expect(rows).toEqual([{ n: 19.99 }, { n: -0.5 }, { n: 0 }]);
    expect(typeof (rows[0] as { n: unknown }).n).toBe("number");
  });

  test("INT8 converts to a float, with float rounding for large values", async () => {
    mockUnsafe.mockResolvedValueOnce(
      bunResult([{ n: "42" }, { n: "9223372036854775807" }], [{ name: "n", type: INT8 }]),
    );
    const { rows } = await pool.query("SELECT 1");
    expect(rows).toEqual([{ n: 42 }, { n: 9223372036854775808 }]);
    expect(typeof (rows[0] as { n: unknown }).n).toBe("number");
  });

  test("DATE converts to the raw string, not a Date", async () => {
    mockUnsafe.mockResolvedValueOnce(
      bunResult([{ d: new Date("2026-10-24T00:00:00.000Z") }], [{ name: "d", type: DATE }]),
    );
    const { rows } = await pool.query("SELECT 1");
    expect(rows).toEqual([{ d: "2026-10-24" }]);
    expect(typeof (rows[0] as { d: unknown }).d).toBe("string");
  });

  test("TIMESTAMPTZ converts to an ISO string (canonical Z form)", async () => {
    mockUnsafe.mockResolvedValueOnce(
      bunResult(
        [{ t: new Date("2026-10-24T12:00:00.000Z") }],
        [{ name: "t", type: TIMESTAMPTZ }],
      ),
    );
    const { rows } = await pool.query("SELECT 1");
    expect(rows).toEqual([{ t: "2026-10-24T12:00:00.000Z" }]);
    expect(typeof (rows[0] as { t: unknown }).t).toBe("string");
  });

  test("JSON and JSONB parse to objects", async () => {
    mockUnsafe.mockResolvedValueOnce(
      bunResult([{ j: '{"a":1}' }, { j: '{"b":2}' }], [{ name: "j", type: JSON }]),
    );
    expect((await pool.query("SELECT 1")).rows).toEqual([{ j: { a: 1 } }, { j: { b: 2 } }]);

    mockUnsafe.mockResolvedValueOnce(
      bunResult([{ j: '{"a":1}' }], [{ name: "j", type: JSONB }]),
    );
    expect((await pool.query("SELECT 1")).rows).toEqual([{ j: { a: 1 } }]);
  });

  test("every other type passes through untouched, nulls included", async () => {
    mockUnsafe.mockResolvedValueOnce(
      bunResult(
        [{ i: 42, b: true, t: "x", n: null }],
        [
          { name: "i", type: INT4 },
          { name: "b", type: BOOL },
          { name: "t", type: TEXT },
          { name: "n", type: TEXT },
        ],
      ),
    );
    const { rows } = await pool.query("SELECT 1");
    expect(rows).toEqual([{ i: 42, b: true, t: "x", n: null }]);
  });

  test("rowCount comes from the result count", async () => {
    mockUnsafe.mockResolvedValueOnce(
      Object.assign([{ a: 1 }, { a: 2 }], { count: 2, columns: [] }),
    );
    expect((await pool.query("SELECT 1")).rowCount).toBe(2);

    mockUnsafe.mockResolvedValueOnce(Object.assign([], { count: 0, columns: [] }));
    const empty = await pool.query("SELECT 1");
    expect(empty.rows).toEqual([]);
    expect(empty.rowCount).toBe(0);
  });
});

describe("withTransaction", () => {
  test("BEGIN, then the callback, then COMMIT, then release; returns the callback value", async () => {
    let seenClient: unknown;
    const result = await withTransaction(async (client) => {
      seenClient = client;
      await client.query("SELECT 1");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(mockReservedUnsafe.mock.calls.map((c) => c[0])).toEqual([
      "BEGIN",
      "SELECT 1",
      "COMMIT",
    ]);
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(seenClient).toBeDefined();
  });

  test("a callback throw rolls back, releases, and rethrows the ORIGINAL error", async () => {
    const boom = new Error("boom");
    await expect(
      withTransaction(async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(mockReservedUnsafe.mock.calls.map((c) => c[0])).toEqual(["BEGIN", "ROLLBACK"]);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  test("a COMMIT failure rolls back, releases, and rethrows the COMMIT error", async () => {
    const commitErr = new Error("commit failed");
    mockReservedUnsafe.mockImplementation(async (sql: string) => {
      if (sql === "COMMIT") throw commitErr;
      return { rows: [], rowCount: 0 };
    });
    await expect(withTransaction(async () => "x")).rejects.toBe(commitErr);
    // The failed COMMIT was itself issued, then the catch rolled back.
    expect(mockReservedUnsafe.mock.calls.map((c) => c[0])).toEqual([
      "BEGIN",
      "COMMIT",
      "ROLLBACK",
    ]);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});
