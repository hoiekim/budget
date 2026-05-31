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

interface ExternalsByTest {
  [testAbsPath: string]: Record<string, string>;
}

const getExternalsByTest = (): ExternalsByTest => {
  const slot = (globalThis as { __externalsByTest?: ExternalsByTest }).__externalsByTest;
  if (!slot) {
    throw new Error(
      "test-bundled: __externalsByTest is missing on globalThis. " +
        "Are you running this test via `bun run test:bundled`?",
    );
  }
  return slot;
};

const callerAbsPath = (callerUrl: string): string => {
  // `import.meta.url` is a file:// URL; strip the protocol so we can
  // look up the test's manifest entry by its on-disk absolute path.
  if (callerUrl.startsWith("file://")) return new URL(callerUrl).pathname;
  return callerUrl;
};

/**
 * Resolve the per-test SHIM absolute path for one `@external` spec, so
 * a test can register `mock.module(shimPath, factory)` against the same
 * identity the bundle's rewritten import uses. Pass `import.meta.url`
 * so the lookup picks the calling test's manifest entry — two tests
 * `@external`-ing the same source have DIFFERENT shim paths and don't
 * collide.
 *
 *   import { externalPath } from "test-bundled";
 *   mock.module(externalPath(import.meta.url, "./api_keys"), factory);
 *
 * `mockExternal(import.meta.url, spec, factory)` below is the one-call
 * shortcut for the common case.
 */
export const externalPath = (callerUrl: string, spec: string): string => {
  const caller = callerAbsPath(callerUrl);
  const map = getExternalsByTest()[caller];
  if (!map) {
    throw new Error(
      `externalPath: no externals map for ${caller}. ` +
        `Add a \`// @external ${spec}\` annotation at the top of the test file.`,
    );
  }
  const target = map[spec];
  if (!target) {
    throw new Error(
      `externalPath: spec "${spec}" is not declared as \`// @external\` in ${caller}.`,
    );
  }
  return target;
};

/**
 * Replace the per-test SHIM module's exports with the test's factory.
 * Shorthand for `mock.module(externalPath(callerUrl, spec), factory)`.
 * Use this when two tests externalize the same source — each lands on
 * a distinct shim identity, so mocks don't shadow each other.
 *
 *   import { mockExternal } from "test-bundled";
 *   mockExternal(import.meta.url, "./api_keys", () => ({ verifyApiKey: mockFn }));
 */
export const mockExternal = (
  callerUrl: string,
  spec: string,
  factory: () => Record<string, unknown>,
): void => {
  mock.module(externalPath(callerUrl, spec), factory);
};
