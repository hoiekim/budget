/**
 * Test-side mock helpers. Tests import these and use them in
 * `beforeAll` / `afterAll` to install + restore process-global
 * `mock.module(...)` overrides cleanly.
 *
 * Why restore: bun's `mock.module()` is process-global and has no
 * `unmock` API — once a file mocks the SQL driver with a FakeSQL, every
 * subsequent file in the same `bun test` process sees the mock unless
 * it's explicitly re-mocked back to real. A bare `globalThis.fetch =`
 * has the same blast radius and no unmock API either. `restoreLeaves()`
 * puts each of them back to the snapshot the preload captured
 * (`globalThis.__REAL_*`) before any test file ran, so the next file
 * starts from a known baseline.
 *
 * Usage pattern:
 *
 *   import { restoreLeaves } from "scripts/test-helpers";
 *   import { afterAll, mock } from "bun:test";
 *
 *   mock.module("./sql-driver", () => driver);
 *
 *   afterAll(restoreLeaves);
 */
import { mock } from "bun:test";
import { resetPool } from "server/lib/postgres/client";

interface RealLeaves {
  __REAL_SQL_DRIVER: Record<string, unknown>;
  __REAL_PASSWORD: Record<string, unknown>;
  __REAL_FETCH: typeof fetch;
  __REAL_ENV: Record<string, string | undefined>;
}

const realLeaves = (): RealLeaves => {
  const g = globalThis as unknown as Partial<RealLeaves>;
  if (!g.__REAL_SQL_DRIVER || !g.__REAL_PASSWORD || !g.__REAL_FETCH || !g.__REAL_ENV) {
    throw new Error(
      "test-helpers: real leaf snapshots missing on globalThis. " +
        "Run tests via `bun test` (which preloads `scripts/test-preload.ts`).",
    );
  }
  return g as RealLeaves;
};

/**
 * Put `globalThis.fetch` back to the runtime's own, for a file that
 * stubbed it.
 *
 * Restore from the preload's snapshot rather than from a value the file
 * read on the way in: `const original = globalThis.fetch` captures
 * whatever the PREVIOUS file left behind, so one file's leak survives
 * every well-behaved restore after it. The snapshot is the only value
 * known to predate every test file.
 */
export const restoreFetch = (): void => {
  globalThis.fetch = realLeaves().__REAL_FETCH;
};

/**
 * Put the market-data env back to the preload's snapshot.
 *
 * Deletes a name that was unset rather than assigning `undefined` to it:
 * `process.env.X = undefined` stores the STRING "undefined", which is truthy,
 * so `getApiKey()` reads it as a real key and the next file's fire-and-forget
 * backfill goes to the live upstream instead of short-circuiting.
 */
export const restoreEnv = (): void => {
  const snapshot = realLeaves().__REAL_ENV;
  // Written out one name at a time for the same reason the snapshot is: a
  // computed key is an env access the `.env.example` scan cannot follow.
  if (snapshot.POLYGON_API_KEY === undefined) delete process.env.POLYGON_API_KEY;
  else process.env.POLYGON_API_KEY = snapshot.POLYGON_API_KEY;
  if (snapshot.POLYGON_RATE_LIMIT_PER_MIN === undefined)
    delete process.env.POLYGON_RATE_LIMIT_PER_MIN;
  else process.env.POLYGON_RATE_LIMIT_PER_MIN = snapshot.POLYGON_RATE_LIMIT_PER_MIN;
  if (snapshot.YAHOO_RATE_LIMIT_PER_MIN === undefined)
    delete process.env.YAHOO_RATE_LIMIT_PER_MIN;
  else process.env.YAHOO_RATE_LIMIT_PER_MIN = snapshot.YAHOO_RATE_LIMIT_PER_MIN;
};

/**
 * Re-mock the standard set of leaf deps (the SQL driver, the password wrapper) back
 * to the real module exports captured by the preload, put
 * `globalThis.fetch` back with the market-data env, and invalidate the
 * lazy SQL cache in `postgres/client.ts` so the next file's first pool
 * use rebuilds against that file's mock (or the real driver if it
 * doesn't mock anything). Pass directly to `afterAll(restoreLeaves)`.
 */
export const restoreLeaves = (): void => {
  const { __REAL_SQL_DRIVER, __REAL_PASSWORD } = realLeaves();
  mock.module("server/lib/postgres/sql-driver", () => __REAL_SQL_DRIVER);
  mock.module("server/lib/password", () => __REAL_PASSWORD);
  restoreFetch();
  restoreEnv();
  resetPool();
};

/** Column names on the left of a `DO UPDATE SET` clause.
 *
 *  Compare the parsed set rather than substring-matching the clause: column
 *  names nest (`holding_account_id` contains `account_id`), so
 *  `expect(clause).not.toContain("account_id")` passes on a clause that
 *  rewrites it.
 *
 *  ```ts
 *  expect(updateColumnsOf(sql)).not.toContain(USER_ID);
 *  ```
 */
export const updateColumnsOf = (sql: string): string[] => {
  const clause = sql.split("DO UPDATE SET")[1];
  if (!clause) return [];
  return clause
    .split(/,\s*/)
    .map((part) => part.trim().split(/\s*=/)[0].trim())
    .filter(Boolean);
};

/** What every `createFakeSql` query resolves to at the executor level. */
export interface FakeQueryResult {
  rows: unknown[];
  rowCount: number | null;
}

export type FakeQuery = (sql: string, values?: unknown[]) => Promise<FakeQueryResult>;

const resolveEmpty: FakeQuery = async () => ({ rows: [], rowCount: 0 });

/**
 * Build a SQL-driver module stub whose pool and reserved client are
 * *separate* mocks.
 *
 * `withTransaction` reaches the database through `pool.connect()`, so a
 * `reserve()` that hands back `pool.unsafe` collapses both into one call
 * log and no assertion can tell where a statement ran. Dropping the
 * `client` argument from a cascade then leaves the suite green while, in
 * production, that cascade commits on its own and survives the caller's
 * rollback.
 *
 * Assert an in-transaction statement against `mockReservedUnsafe`, and
 * its absence from `mockUnsafe`.
 *
 * ```ts
 * const { driver, mockUnsafe, mockReservedUnsafe, resetSqlMocks } = createFakeSql();
 * mock.module("./sql-driver", () => driver);
 * ```
 *
 * The stub translates at the seam: tests script executor-level
 * `{ rows, rowCount }` results (the shape `pool.query` resolves to), and
 * the fake's `unsafe` hands the production adapter the Bun-shaped array
 * with `count`/`columns` it would get from a real client, so the
 * adapter's row mapping runs for real. A test that wants to pin the
 * adapter's type conversions scripts a Bun-shaped array directly — it
 * passes through untouched (see `client-pins.test.ts`).
 *
 * `resetSqlMocks` puts `implementation` back afterwards: bun's `mockReset`
 * drops it, and an `unsafe()` that resolves to `undefined` blows up inside
 * `withTransaction` long before the assertion it was meant to reach.
 */
export const createFakeSql = (implementation: FakeQuery = resolveEmpty) => {
  const mockUnsafe = mock(implementation);
  const mockReservedUnsafe = mock(implementation);
  const mockRelease = mock(() => {});
  const mockClose = mock(async () => {});

  const toBunResult = (value: unknown): unknown => {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "rows" in value &&
      "rowCount" in value
    ) {
      const { rows, rowCount } = value as FakeQueryResult;
      return Object.assign([...rows], { count: rowCount, columns: [] });
    }
    return value;
  };

  const unsafe = async (sql: string, values?: unknown[]) =>
    toBunResult(await mockUnsafe(sql, values));
  const reservedUnsafe = async (sql: string, values?: unknown[]) =>
    toBunResult(await mockReservedUnsafe(sql, values));
  const mockReserve = mock(async () => ({ unsafe: reservedUnsafe, release: mockRelease }));

  const constructedOptions: Record<string, unknown>[] = [];
  class FakeSQL {
    unsafe = unsafe;
    close = mockClose;
    reserve = mockReserve;
    constructor(options: Record<string, unknown>) {
      constructedOptions.push(options);
    }
  }

  const driver = { SQL: FakeSQL };

  return {
    driver,
    mockUnsafe,
    mockReservedUnsafe,
    mockReserve,
    mockRelease,
    mockClose,
    constructedOptions,
    resetSqlMocks: () => {
      mockUnsafe.mockReset();
      mockReservedUnsafe.mockReset();
      mockUnsafe.mockImplementation(implementation);
      mockReservedUnsafe.mockImplementation(implementation);
      mockReserve.mockClear();
      mockRelease.mockClear();
      mockClose.mockClear();
    },
    clearSqlMocks: () => {
      mockUnsafe.mockClear();
      mockReservedUnsafe.mockClear();
      mockReserve.mockClear();
      mockRelease.mockClear();
      mockClose.mockClear();
    },
  };
};
