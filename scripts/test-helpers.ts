/**
 * Test-side mock helpers. Tests import these and use them in
 * `beforeAll` / `afterAll` to install + restore process-global
 * `mock.module(...)` overrides cleanly.
 *
 * Why restore: bun's `mock.module()` is process-global and has no
 * `unmock` API — once a file mocks `"pg"` with a FakePool, every
 * subsequent file in the same `bun test` process sees the mock unless
 * it's explicitly re-mocked back to real. `restoreLeaves()` re-mocks
 * each leaf to the snapshot the preload captured (`globalThis.__REAL_*`)
 * before any test file ran, so the next file starts from a known
 * baseline.
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
}

const realLeaves = (): RealLeaves => {
  const g = globalThis as unknown as Partial<RealLeaves>;
  if (!g.__REAL_PG || !g.__REAL_BCRYPT) {
    throw new Error(
      "test-helpers: real leaf snapshots missing on globalThis. " +
        "Run tests via `bun test` (which preloads `scripts/test-preload.ts`).",
    );
  }
  return g as RealLeaves;
};

/**
 * Re-mock the standard set of leaf deps (`pg`, `bcrypt`) back to the
 * real module exports captured by the preload, and invalidate the
 * lazy Pool cache in `postgres/client.ts` so the next file's first
 * pool use rebuilds against that file's mock (or real pg if it
 * doesn't mock anything). Pass directly to `afterAll(restoreLeaves)`.
 */
export const restoreLeaves = (): void => {
  const { __REAL_PG, __REAL_BCRYPT } = realLeaves();
  mock.module("pg", () => __REAL_PG);
  mock.module("bcrypt", () => __REAL_BCRYPT);
  resetPool();
};
