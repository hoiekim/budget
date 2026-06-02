/**
 * Unified test runner — every `*.test.{ts,tsx}` under `src/` runs through
 * here.
 *
 * Discovery: scan `src/**` for `*.test.{ts,tsx}`. Each file is classified
 * by whether it carries a `// @bundles <relPath>` annotation (and any
 * `// @external …` lines).
 *
 *   - **Annotated (bundled)** tests get per-test-bundle isolation:
 *       1. Build the annotated source into a unique bundle under
 *          `.test-bundles/`, with leaf node_modules deps + any
 *          `@external` paths kept as runtime imports.
 *       2. Register a `mock.module(<source-abs>, () => require(<bundle>))`
 *          in the preload so the test's natural `import { foo } from
 *          "./source"` lands on the bundle's exports.
 *   - **Non-annotated** tests run as plain `bun:test` files with only a
 *     `globalThis.window = {}` stub for client-side env detection.
 *
 * The two groups run in SEPARATE `bun test` processes — the bundled
 * group's `mock.module("pg", …)` etc. would otherwise contaminate the
 * non-bundled group's real-pg imports (pg-pool init reads
 * `types.builtins.NUMERIC` which a FakePool mock doesn't supply).
 *
 * Each bundle's body runs exactly once even if multiple tests cover the
 * same source. For DIFFERENT sources, each bundle is its own ESM module
 * record and captures its own leaf-dep mocks at first load via static
 * binding. The test's `mock.module("pg", …)` is hoisted by bun:test to
 * before its own imports, so by the time the source import (redirected
 * to the bundle) loads, the leaf-dep mock is live.
 *
 * Wired into package.json as `bun run test`.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { Glob } from "bun";
import { buildBundle, cleanBundleDir, bundlePathFor, getBundleDir, getRepoRoot } from "./build.ts";

const REPO_ROOT = getRepoRoot();

/**
 * Barrels whose REAL exports the preload pre-captures into
 * `globalThis.__realBarrels` so `mockBarrel(name, …)` can spread them
 * without picking up another test's mock. Kept narrow on purpose:
 * `server` and `client` have eager side-effect imports (postgres pool,
 * route registration, etc.) that we don't want triggered at preload.
 * Tests that need to mock a single export from those barrels should
 * use `@external <deep-path>` + a fresh mock instead.
 */
const REAL_BARRELS = ["common"];

interface Annotation {
  external: string[];
  /** True iff the test file calls `bundleOf(` anywhere — the marker we
   *  use to decide whether to build a bundle for this test. Replaces
   *  the old `// @bundles` annotation: a test is bundled iff it
   *  actually uses the framework's bundle. */
  usesBundleOf: boolean;
}

const parseAnnotations = async (testAbs: string): Promise<{ text: string; ann: Annotation }> => {
  const text = await readFile(testAbs, "utf8");
  // Match `bundleOf(` or `bundleOf<…>(` (generic-typed call). The
  // import line `import { bundleOf } from "test-bundled"` is excluded by
  // requiring a `(` or `<` after the identifier — `bundleOf }` doesn't
  // qualify.
  const ann: Annotation = {
    external: [],
    usesBundleOf: /\bbundleOf\s*[<(]/.test(text),
  };
  // `@external` is still a comment-driven hint — the build plugin needs
  // the list of specifiers to keep external before the bundle is built.
  for (const line of text.split("\n", 30)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (!trimmed.startsWith("//")) {
      if (trimmed.startsWith("import ") || trimmed.startsWith("export ")) break;
      continue;
    }
    const externalM = /^\/\/\s*@external\s+(.+?)\s*$/.exec(line);
    if (externalM) ann.external.push(externalM[1]);
  }
  return { text, ann };
};

/**
 * Derive the source-under-test from the test file's path, by convention:
 *
 *   1. `foo.test.ts`               → `foo.ts` in the same dir.
 *   2. `Calculations.holdings.test.ts` → drop dotted suffixes from the
 *      right until a sibling resolves: `Calculations.holdings.ts` →
 *      `Calculations.ts`. Catches the "multiple test files per source"
 *      pattern.
 *
 * Returns `null` if no candidate exists — the test stays plain (the
 * framework offers `bundleOf` only when there's a source to bundle).
 * Symbol-named tests (`isApiPath.test.ts` against `index.ts`) are
 * deliberately NOT auto-resolved; the codebase's convention is one
 * source-per-file, so a symbol-only test should be a real file
 * extraction instead of relying on framework "magic".
 */
const inferSourceFromTestPath = (testAbs: string): string | null => {
  const dir = dirname(testAbs);
  // Strip `.test.ts` / `.test.tsx` to get the base, then peel one
  // dotted suffix per iteration.
  let base = testAbs.replace(/\.test\.(ts|tsx)$/, "");
  if (base === testAbs) return null;
  while (true) {
    const baseName = base.slice(dir.length + 1);
    if (baseName === "") return null;
    for (const ext of [".ts", ".tsx"] as const) {
      const candidate = `${base}${ext}`;
      if (existsSync(candidate)) return candidate;
    }
    // Drop the rightmost dotted suffix, e.g.
    // `Calculations.holdings` → `Calculations`.
    const trimmed = base.replace(/\.[^./\\]+$/, "");
    if (trimmed === base) return null;
    base = trimmed;
  }
};

const COLOR_DIM = "\x1b[90m";
const COLOR_BOLD = "\x1b[1m";
const COLOR_RESET = "\x1b[0m";

const main = async (): Promise<void> => {
  const t0 = performance.now();

  // 1. Discover every `*.test.{ts,tsx}` under src/. Partition into
  // bundled (have `@bundles` annotation) and plain.
  const allTestFiles: string[] = [];
  const glob = new Glob("**/*.test.{ts,tsx}");
  for await (const rel of glob.scan({ cwd: resolve(REPO_ROOT, "src"), absolute: false })) {
    allTestFiles.push(resolve(REPO_ROOT, "src", rel));
  }

  // A test is bundled iff it calls `bundleOf(`. The source-under-test
  // is inferred from the test path (see `inferSourceFromTestPath`); no
  // explicit `// @bundles` annotation needed. A test that calls
  // `bundleOf` without a resolvable source is a configuration error.
  const manifest: Array<{ test: string; source: string; external: string[]; bundle: string }> = [];
  const plainTests: string[] = [];
  for (const testAbs of allTestFiles) {
    const { ann } = await parseAnnotations(testAbs);
    if (!ann.usesBundleOf) {
      plainTests.push(testAbs);
      continue;
    }
    const sourceAbs = inferSourceFromTestPath(testAbs);
    if (!sourceAbs) {
      throw new Error(
        `${testAbs} calls bundleOf(...) but no sibling source resolved. ` +
          `Rename the test so its basename matches a sibling \`*.ts\` file ` +
          `(e.g. \`foo.test.ts\` → \`foo.ts\`).`,
      );
    }
    manifest.push({
      test: testAbs,
      source: sourceAbs,
      external: ann.external,
      bundle: bundlePathFor(testAbs, sourceAbs),
    });
  }

  if (allTestFiles.length === 0) {
    process.stdout.write("no test files discovered under src/\n");
    return;
  }

  process.stdout.write(
    `${COLOR_BOLD}discovered${COLOR_RESET} ${allTestFiles.length} test files ` +
      `(${manifest.length} bundled, ${plainTests.length} plain)\n`,
  );

  // 2. Clean + build bundles in parallel. Each build also emits the
  // per-test shim files for its `@external` specs and rewrites the
  // bundle's imports to those shim paths (see build.ts).
  await cleanBundleDir();
  const t1 = performance.now();
  const buildResults = await Promise.all(
    manifest.map((m) =>
      buildBundle({ source: m.source, test: m.test, externalSpecs: m.external }),
    ),
  );
  const buildMs = performance.now() - t1;
  // Per-test map { test-abs-path → { spec → shim-abs-path } }. Tests use
  // `mockExternal(import.meta.url, spec, factory)` to look up the shim
  // path and register a mock at that identity.
  const externalsByTest: Record<string, Record<string, string>> = {};
  for (let i = 0; i < manifest.length; i++) {
    const m = manifest[i];
    const r = buildResults[i];
    if (Object.keys(r.externalResolutions).length > 0) {
      externalsByTest[m.test] = r.externalResolutions;
    }
  }

  // 3. Generate the preload. Two parts:
  //    a. Pre-capture the REAL exports of each barrel in REAL_BARRELS,
  //       BEFORE any source→bundle redirect is registered, and stash on
  //       globalThis.__realBarrels for `mockBarrel(name, …)` to spread.
  //       This closes the cross-test contamination gap where testB's
  //       `import * as commonReal from "common"` would otherwise pick up
  //       testA's mock.
  //    b. Register a synthetic mock at every SOURCE abs path that
  //       redirects to its bundle via require() (sync, returns the
  //       bundle's exports). The factory runs lazily on first import,
  //       so the test's own `mock.module("pg", …)` etc. are already
  //       active by then and the bundle's leaf-dep imports see them.
  // Per-test BUNDLE PATHS map. Tests load their own bundle directly via
  // `bundleOf(import.meta.url)` from `test-bundled` runtime — no
  // source→bundle `mock.module` redirect anywhere.
  //
  // Why no redirects: bun's `mock.module(path, factory)` is EAGER for
  // already-cached `path`s. When a previous test's transitive imports
  // loaded the source (e.g. via the `server` barrel), a later test's
  // wrapper-level `mock.module(source, () => require(bundle))` fires
  // the factory IMMEDIATELY — and the bundle loads BEFORE that test's
  // `mock.module("pg", FakePool)` runs, so the bundle binds REAL pg.
  // The intended FakePool never takes effect.
  //
  // Per-test bundle paths sidestep this entirely: each test gets a
  // UNIQUE bundle file (keyed on (test, source)). The test imports its
  // bundle by absolute path. Sibling tests can lazily load REAL
  // sources via transitive imports without touching this test's
  // bundle module record.
  const bundlesByTest: Record<string, string> = {};
  for (const m of manifest) bundlesByTest[m.test] = m.bundle;

  const preloadPath = resolve(getBundleDir(), "preload.ts");
  const preloadBody =
    `import { mock as _ } from "bun:test";\n` + // ensure bun:test is initialized
    `Object.assign(globalThis, { window: {} });\n\n` +
    REAL_BARRELS.map(
      (b) => `const __${b} = require(${JSON.stringify(b)});`,
    ).join("\n") +
    `\n\n` +
    `(globalThis as any).__realBarrels = {\n` +
    REAL_BARRELS.map((b) => `  ${JSON.stringify(b)}: __${b},`).join("\n") +
    `\n};\n\n` +
    `(globalThis as any).__externalsByTest = ${JSON.stringify(externalsByTest, null, 2)};\n` +
    `(globalThis as any).__bundlesByTest = ${JSON.stringify(bundlesByTest, null, 2)};\n`;
  await mkdir(getBundleDir(), { recursive: true });
  await writeFile(preloadPath, preloadBody);

  process.stdout.write(
    `${COLOR_DIM}built ${manifest.length} bundles in ${buildMs.toFixed(0)}ms${COLOR_RESET}\n`,
  );

  // Single `bun test` process for ALL tests. Bundled tests load their
  // own unique bundle via `bundleOf(import.meta.url)`; plain tests
  // import sources directly. Per-test bundle paths mean no cascade —
  // a plain test's transitive load of a source never repoints a
  // bundled test's view of that source (bundles use unique abs paths
  // that the plain side never touches). Each test's `mock.module("pg",
  // …)` is per-file-scoped in bun:test, so siblings don't interfere.
  const t2 = performance.now();
  const coverageArgs = process.env.COVERAGE
    ? ["--coverage", "--coverage-reporter=lcov"]
    : [];
  const proc = Bun.spawn(
    ["bun", "test", "--preload", preloadPath, ...coverageArgs, ...allTestFiles],
    { cwd: REPO_ROOT, stdout: "inherit", stderr: "inherit" },
  );
  const exitCode = await proc.exited;
  const runMs = performance.now() - t2;
  const totalMs = performance.now() - t0;
  process.stdout.write(
    `\n${COLOR_DIM}build=${buildMs.toFixed(0)}ms  run=${runMs.toFixed(0)}ms  total=${totalMs.toFixed(0)}ms${COLOR_RESET}\n`,
  );
  process.exit(exitCode);
};

main().catch((err) => {
  process.stderr.write(`test-bundled crashed: ${err?.stack ?? err}\n`);
  process.exit(2);
});
