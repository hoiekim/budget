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
import { resolve } from "node:path";
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
  bundles?: string;
  external: string[];
}

const parseAnnotations = async (testAbs: string): Promise<Annotation> => {
  const text = await readFile(testAbs, "utf8");
  const lines = text.split("\n", 30);
  const out: Annotation = { external: [] };
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (!trimmed.startsWith("//")) {
      if (trimmed.startsWith("import ") || trimmed.startsWith("export ")) break;
      continue;
    }
    const bundlesM = /^\/\/\s*@bundles\s+(.+?)\s*$/.exec(line);
    if (bundlesM) {
      out.bundles = bundlesM[1];
      continue;
    }
    const externalM = /^\/\/\s*@external\s+(.+?)\s*$/.exec(line);
    if (externalM) out.external.push(externalM[1]);
  }
  return out;
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

  const manifest: Array<{ test: string; source: string; external: string[]; bundle: string }> = [];
  const plainTests: string[] = [];
  for (const testAbs of allTestFiles) {
    const ann = await parseAnnotations(testAbs);
    if (ann.bundles) {
      const sourceAbs = resolve(REPO_ROOT, ann.bundles);
      manifest.push({
        test: testAbs,
        source: sourceAbs,
        external: ann.external,
        bundle: bundlePathFor(sourceAbs),
      });
    } else {
      plainTests.push(testAbs);
    }
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
  const preloadPath = resolve(getBundleDir(), "preload.ts");
  // ES-imports hoist above any top-level statement, so we can't `import`
  // the barrels and then run `Object.assign(globalThis, { window: {} })`
  // — the barrel would be evaluated BEFORE the window stub runs and
  // `common/utils:environment` would resolve to "server" instead of
  // "unknown", flipping client-side Dictionary writes into no-ops.
  // `require()` runs at statement order, so the window stub goes first
  // and the barrel snapshot fires after.
  const preloadBody =
    `import { mock } from "bun:test";\n` +
    // Stub `globalThis.window` for client-side env detection (was a
    // separate `src/client/test-setup.ts` preload before unification).
    `Object.assign(globalThis, { window: {} });\n\n` +
    REAL_BARRELS.map(
      (b) => `const __${b} = require(${JSON.stringify(b)});`,
    ).join("\n") +
    `\n\n` +
    `(globalThis as any).__realBarrels = {\n` +
    REAL_BARRELS.map((b) => `  ${JSON.stringify(b)}: __${b},`).join("\n") +
    `\n};\n\n` +
    `(globalThis as any).__externalsByTest = ${JSON.stringify(externalsByTest, null, 2)};\n\n` +
    manifest
      .map(
        (m) =>
          `mock.module(${JSON.stringify(m.source)}, () => require(${JSON.stringify(m.bundle)}));`,
      )
      .join("\n") +
    "\n";
  await mkdir(getBundleDir(), { recursive: true });
  await writeFile(preloadPath, preloadBody);

  // 3b. Plain-tests preload — just the window stub. Lives alongside the
  // bundled preload but stays minimal so non-bundled tests don't inherit
  // any source→bundle redirects that would only be valid in the bundled
  // process.
  const plainPreloadPath = resolve(getBundleDir(), "preload-plain.ts");
  const plainPreloadBody = `Object.assign(globalThis, { window: {} });\n`;
  await writeFile(plainPreloadPath, plainPreloadBody);

  process.stdout.write(
    `${COLOR_DIM}built ${manifest.length} bundles in ${buildMs.toFixed(0)}ms${COLOR_RESET}\n`,
  );

  // 4. Run the two groups in SEPARATE bun test processes. Bundled-side
  // `mock.module("pg", …)` would otherwise contaminate the plain side's
  // real pg imports (pg-pool reads `types.builtins.NUMERIC` which a
  // FakePool mock doesn't supply).
  const t2 = performance.now();
  const coverageArgs = process.env.COVERAGE
    ? ["--coverage", "--coverage-reporter=lcov"]
    : [];
  const runGroup = async (preload: string, files: string[]): Promise<number> => {
    if (files.length === 0) return 0;
    const proc = Bun.spawn(
      ["bun", "test", "--preload", preload, ...coverageArgs, ...files],
      { cwd: REPO_ROOT, stdout: "inherit", stderr: "inherit" },
    );
    return proc.exited;
  };
  const bundledExit = await runGroup(preloadPath, manifest.map((m) => m.test));
  const plainExit = await runGroup(plainPreloadPath, plainTests);
  const exitCode = bundledExit || plainExit;
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
