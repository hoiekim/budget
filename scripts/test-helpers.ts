/**
 * Test-side mock helpers. Tests import these and use them in
 * `beforeAll` / `afterAll` to install + restore process-global
 * `mock.module(...)` overrides cleanly.
 *
 * Why restore: bun's `mock.module()` is process-global and has no
 * `unmock` API — once a file mocks `"pg"` with a FakePool, every
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
 *   mock.module("pg", () => ({ Pool: FakePool, ... }));
 *
 *   afterAll(restoreLeaves);
 */
import { mock } from "bun:test";
import { resetPool } from "server/lib/postgres/client";

interface RealLeaves {
  __REAL_PG: Record<string, unknown> & { default: unknown };
  __REAL_BCRYPT: Record<string, unknown> & { default: unknown };
  __REAL_FETCH: typeof fetch;
  __REAL_ENV: Record<string, string | undefined>;
}

const realLeaves = (): RealLeaves => {
  const g = globalThis as unknown as Partial<RealLeaves>;
  if (!g.__REAL_PG || !g.__REAL_BCRYPT || !g.__REAL_FETCH || !g.__REAL_ENV) {
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
 * Re-mock the standard set of leaf deps (`pg`, `bcrypt`) back to the
 * real module exports captured by the preload, put `globalThis.fetch`
 * back with the market-data env, and invalidate the lazy Pool cache in
 * `postgres/client.ts` so the next file's first pool use rebuilds
 * against that file's mock (or real pg if it doesn't mock anything).
 * Pass directly to `afterAll(restoreLeaves)`.
 */
export const restoreLeaves = (): void => {
  const { __REAL_PG, __REAL_BCRYPT } = realLeaves();
  mock.module("pg", () => __REAL_PG);
  mock.module("bcrypt", () => __REAL_BCRYPT);
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

/** What every `createFakePg` query resolves to. */
export interface FakeQueryResult {
  rows: unknown[];
  rowCount: number | null;
}

export type FakeQuery = (sql: string, values?: unknown[]) => Promise<FakeQueryResult>;

const resolveEmpty: FakeQuery = async () => ({ rows: [], rowCount: 0 });

/**
 * Build a `pg` module stub whose pool and transaction client are *separate*
 * mocks.
 *
 * `withTransaction` reaches the database through `pool.connect()`, so a
 * `connect()` that hands back `pool.query` collapses both into one call log
 * and no assertion can tell where a statement ran. Dropping the `client`
 * argument from a cascade then leaves the suite green while, in production,
 * that cascade commits on its own and survives the caller's rollback.
 *
 * Assert an in-transaction statement against `mockClientQuery`, and its
 * absence from `mockQuery`.
 *
 * ```ts
 * const { pg, mockQuery, mockClientQuery, resetQueryMocks } = createFakePg();
 * mock.module("pg", () => pg);
 * ```
 *
 * `resetQueryMocks` puts `implementation` back afterwards: bun's `mockReset`
 * drops it, and a `query()` that resolves to `undefined` blows up inside
 * `withTransaction` long before the assertion it was meant to reach.
 */
export const createFakePg = (implementation: FakeQuery = resolveEmpty) => {
  const mockQuery = mock(implementation);
  const mockClientQuery = mock(implementation);

  class FakePool {
    query = mockQuery;
    end = async () => {};
    connect = async () => ({ query: mockClientQuery, release: () => {} });
  }

  const types = { setTypeParser: () => {} };
  const pg = { Pool: FakePool, types, default: { Pool: FakePool, types } };

  return {
    pg,
    mockQuery,
    mockClientQuery,
    resetQueryMocks: () => {
      mockQuery.mockReset();
      mockClientQuery.mockReset();
      mockQuery.mockImplementation(implementation);
      mockClientQuery.mockImplementation(implementation);
    },
    clearQueryMocks: () => {
      mockQuery.mockClear();
      mockClientQuery.mockClear();
    },
  };
};
