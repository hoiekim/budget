// Behavior pins for the pg driver surface in ./client, written so the
// follow-up migration (pg -> Bun's native SQL client) can prove identical
// behavior. These pin the OBSERVABLE contract, not pg internals:
//
// - the pool is constructed with the production settings (max, idle and
//   connection timeouts),
// - the custom type parsers shape values exactly the way callers consume
//   them (NUMERIC/INT8 as floats, DATE as a raw string, TIMESTAMPTZ as an
//   ISO string), with every other type delegating to pg's own parser,
// - withTransaction's BEGIN/COMMIT/ROLLBACK/release sequencing, including
//   that the ORIGINAL error propagates after a rollback.
//
// What these tests deliberately do NOT pin: the wire format pg speaks, and
// anything about the pool's internals. A migration that changes those but
// preserves the contracts above keeps every test here green.
//
// CI has no Postgres service (see .github/workflows/ci.yml), so these run
// against a recording fake pool, not a live database. The type-parser
// expectations were validated against real pg output formats; the live
// round-trip check for the migration author is documented in the PR body.
import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";

// Real pg exports, snapshotted by scripts/test-preload.ts before any test
// file could mock them. The custom parsers in ./client compare against
// these builtins, so the mock below must carry the REAL ones — a mock
// with `builtins: {}` would make every OID comparison miss.
const realPg = (
  globalThis as unknown as {
    __REAL_PG: {
      types: {
        builtins: Record<string, number>;
        getTypeParser: (id: number, format?: string) => (value: string) => unknown;
      };
    };
  }
).__REAL_PG;
if (!realPg?.types?.builtins) {
  throw new Error("client-pins: real pg snapshot missing — run via `bun test` with the preload");
}
const realBuiltins = realPg.types.builtins;
const realGetTypeParser = realPg.types.getTypeParser;

const mockClientQuery = mock(async () => ({ rows: [], rowCount: 0 }));
const mockRelease = mock(() => {});
const mockConnect = mock(async () => ({ query: mockClientQuery, release: mockRelease }));

const ctorConfigs: Record<string, unknown>[] = [];
class RecordingPool {
  config: Record<string, unknown>;
  query = mock(async () => ({ rows: [], rowCount: 0 }));
  connect = mockConnect;
  constructor(config: Record<string, unknown>) {
    this.config = config;
    ctorConfigs.push(config);
  }
}

const mockTypes = {
  builtins: realBuiltins,
  getTypeParser: realGetTypeParser,
  setTypeParser: () => {},
};
mock.module("pg", () => ({
  Pool: RecordingPool,
  types: mockTypes,
  default: { Pool: RecordingPool, types: mockTypes },
}));

const { pool, resetPool, withTransaction } = await import("./client");

afterAll(restoreLeaves);

beforeEach(() => {
  mockClientQuery.mockClear();
  mockRelease.mockClear();
  mockConnect.mockClear();
  mockClientQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
  resetPool();
});

const poolConfig = () => {
  void pool.query; // force instantiation through the lazy Proxy
  const config = ctorConfigs.at(-1) as {
    max: number;
    idleTimeoutMillis: number;
    connectionTimeoutMillis: number;
    types: { getTypeParser: (id: number, format?: string) => (value: string) => unknown };
  };
  return config;
};

describe("pool construction", () => {
  test("uses the production pool settings", () => {
    const config = poolConfig();
    expect(config.max).toBe(20);
    expect(config.idleTimeoutMillis).toBe(30000);
    expect(config.connectionTimeoutMillis).toBe(2000);
  });

  test("carries a custom type-parser set (asserted in detail below)", () => {
    expect(typeof poolConfig().types.getTypeParser).toBe("function");
  });
});

describe("custom type parsers", () => {
  // pg hands the parser the raw text of the value; the parser's return is
  // what every caller in the repo consumes. NUMERIC/INT8 as floats (not
  // strings, not BigInt) is the single most migration-sensitive shape here:
  // a driver that returns BigInt for int8 would silently change every
  // amount/count comparison downstream.
  test("NUMERIC parses to a float", () => {
    const parse = poolConfig().types.getTypeParser(realBuiltins.NUMERIC, "text");
    expect(parse("19.99")).toBe(19.99);
    expect(parse("-0.5")).toBe(-0.5);
    expect(parse("0")).toBe(0);
    expect(typeof parse("19.99")).toBe("number");
  });

  test("INT8 parses to a float, with float rounding for large values", () => {
    const parse = poolConfig().types.getTypeParser(realBuiltins.INT8, "text");
    expect(parse("42")).toBe(42);
    expect(typeof parse("42")).toBe("number");
    // 9223372036854775807 is not representable as a float; pg's contract
    // here is parseFloat, so the migration must reproduce the rounding,
    // not "fix" it to BigInt.
    expect(parse("9223372036854775807")).toBe(9223372036854775808);
  });

  test("DATE parses to the raw string, not a Date", () => {
    const parse = poolConfig().types.getTypeParser(realBuiltins.DATE, "text");
    expect(parse("2026-10-24")).toBe("2026-10-24");
    expect(typeof parse("2026-10-24")).toBe("string");
  });

  test("TIMESTAMPTZ parses to an ISO string with a colon in the offset", () => {
    const parse = poolConfig().types.getTypeParser(realBuiltins.TIMESTAMPTZ, "text");
    // pg emits whole-hour offsets without minutes ("+00"); the parser
    // normalizes to "+00:00" so the result is a valid ISO string.
    expect(parse("2026-10-24 12:00:00+00")).toBe("2026-10-24T12:00:00+00:00");
    expect(parse("2026-10-24 12:00:00.123+00:30")).toBe("2026-10-24T12:00:00.123+00:30");
    expect(parse("2026-10-24 12:00:00-05")).toBe("2026-10-24T12:00:00-05:00");
  });

  test("every other type delegates to pg's own parser", () => {
    const getParser = poolConfig().types.getTypeParser;
    const ours = getParser(realBuiltins.INT4, "text");
    const pg = realGetTypeParser(realBuiltins.INT4, "text");
    expect(ours("42")).toBe(pg("42"));
    expect(ours("42")).toBe(42);
    const oursBool = getParser(realBuiltins.BOOL, "text");
    const pgBool = realGetTypeParser(realBuiltins.BOOL, "text");
    expect(oursBool("t")).toBe(pgBool("t"));
    expect(oursBool("t")).toBe(true);
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
    expect(mockClientQuery.mock.calls.map((c) => c[0])).toEqual([
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
    expect(mockClientQuery.mock.calls.map((c) => c[0])).toEqual(["BEGIN", "ROLLBACK"]);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  test("a COMMIT failure rolls back, releases, and rethrows the COMMIT error", async () => {
    const commitErr = new Error("commit failed");
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql === "COMMIT") throw commitErr;
      return { rows: [], rowCount: 0 };
    });
    await expect(withTransaction(async () => "x")).rejects.toBe(commitErr);
    // The failed COMMIT was itself issued, then the catch rolled back.
    expect(mockClientQuery.mock.calls.map((c) => c[0])).toEqual(["BEGIN", "COMMIT", "ROLLBACK"]);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});
