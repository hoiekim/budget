/**
 * Test-side runtime for `.test.bundle.ts` files.
 *
 * The orchestrator's preload pre-captures the unmocked exports of each
 * declared barrel (e.g. `common`) once at startup and stashes them on
 * `globalThis.__realBarrels`. `mockBarrel(name, overrides)` then spreads
 * that pristine snapshot under the test's override map and registers a
 * `mock.module(name, …)`. The result: every test sees the genuinely-real
 * barrel as its base, never another test's mock leaking through the
 * spread.
 *
 * Tests import this via the `test-bundled` tsconfig alias.
 */
import { mock } from "bun:test";

interface RealBarrels {
  [name: string]: Record<string, unknown>;
}

const getRealBarrels = (): RealBarrels => {
  const slot = (globalThis as { __realBarrels?: RealBarrels }).__realBarrels;
  if (!slot) {
    throw new Error(
      "test-bundled: __realBarrels is missing on globalThis. " +
        "Are you running this test via `bun run test:bundled` (which preloads the barrel snapshot)?",
    );
  }
  return slot;
};

/**
 * Mock a barrel module while preserving every export the test doesn't
 * override. `overrides` replaces the listed keys; everything else is
 * the real implementation captured at preload time.
 *
 *   mockBarrel("common", { myModule: mockMyModule });
 *
 * The barrel must be declared in the orchestrator's `REAL_BARRELS` list
 * (currently `common`) so the preload captures it before any test runs.
 */
export const mockBarrel = (name: string, overrides: Record<string, unknown>): void => {
  const real = getRealBarrels()[name];
  if (!real) {
    throw new Error(
      `mockBarrel("${name}", …): no pre-captured snapshot for "${name}". ` +
        `Add it to REAL_BARRELS in scripts/test-bundled/index.ts.`,
    );
  }
  mock.module(name, () => ({ ...real, ...overrides }));
};
