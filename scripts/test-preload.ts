/**
 * Test preload — runs ONCE before any test file in `bun test`.
 *
 * Two jobs:
 *   1. Stub `globalThis.window = {}` so client-side env detection
 *      (`src/common/utils:environment`) resolves to "unknown" instead of
 *      "server" in test runs. Without this, `Dictionary.set()` no-ops
 *      and holdings-calculation tests fail.
 *   2. Capture the REAL exports of leaf node-modules that tests
 *      commonly mock (`pg`, `bcrypt`). Tests can then `afterAll`-restore
 *      via these snapshots so a previous test file's
 *      `mock.module("pg", FakePool)` doesn't leak into the next file's
 *      assumptions.
 *
 *      The snapshots are taken at preload time — BEFORE any test file
 *      has a chance to call `mock.module(...)` — so they're guaranteed
 *      to be the real module exports.
 *
 * The `globalThis.__REAL_*` properties are used by tests' afterAll
 * hooks via the `restoreLeaves()` helper in `scripts/test-helpers.ts`.
 */

Object.assign(globalThis, { window: {} });

// Capture real leaf-dep exports for tests' afterAll restoration. `require`
// runs at statement-order (vs ESM `import` which hoists), so the window
// stub above lands first — `common`-side modules consumed by these
// captures will see the stub.
//
// We spread the full namespace (not just a hand-picked subset) because
// these libs' methods reference each other through `module.exports` at
// runtime — e.g. `bcrypt.hash` internally calls `module.exports.genSalt`.
// If `restoreLeaves` then re-mocks bcrypt to a partial object, the
// missing-internal-reference crashes the next test file's bcrypt call.
const realPg = require("pg");
const realBcrypt = require("bcrypt");

(globalThis as Record<string, unknown>).__REAL_PG = {
  ...realPg,
  default: realPg.default ?? realPg,
};
(globalThis as Record<string, unknown>).__REAL_BCRYPT = {
  ...realBcrypt,
  default: realBcrypt.default ?? realBcrypt,
};
