/**
 * The repo's single seam to Bun's native SQL client.
 *
 * Production code never imports `SQL` from `"bun"` directly — it imports
 * from here. That matters because `bun:test`'s `mock.module(...)` cannot
 * override a builtin module: mocking `"bun"` still hands the importing
 * module the real `SQL`. Mocking this wrapper module works, so the whole
 * test suite's fake-database seam lives here (see
 * `scripts/test-helpers.ts#createFakeSql`).
 */
export { SQL } from "bun";
