/**
 * Helpers used inside converted tests under `scripts/test-bundled/bundled-tests/`.
 *
 * `bundlePath` and `externalPath` mirror the orchestrator's path logic so
 * each test can predict where its bundle lives and what absolute path to
 * pass to `mock.module(...)` for relative-path externals.
 */
import { resolve, dirname } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

/**
 * Compute the bundle path for a given source (repo-root-relative).
 * Must stay in sync with `bundlePathFor` in build.ts.
 */
export const bundlePath = (relSource: string): string => {
  const flat = relSource.replace(/\.(ts|tsx)$/, "").replace(/[\/\\]/g, "__");
  return resolve(REPO_ROOT, ".test-bundles", `${flat}.bundle.js`);
};

/**
 * Resolve a relative import specifier (`./foo`, `../bar`) against the
 * source file's location. Used by tests to construct the absolute path
 * for a `mock.module(...)` call against a sibling module that was
 * declared external in the bundle.
 */
export const externalPath = (relSource: string, spec: string): string => {
  const sourceAbs = resolve(REPO_ROOT, relSource);
  const baseDir = dirname(sourceAbs);
  const noExt = resolve(baseDir, spec);
  // The orchestrator's resolver prefers `.ts`, then `.tsx`, then index.
  // Mirror that here — assume `.ts` for repo-local sibling modules.
  return `${noExt}.ts`;
};
