/**
 * Per-test-bundle runner — preload-driven source-import redirect.
 *
 * Discovery: scan `src/**` for `*.test.{ts,tsx}` files containing a
 *   `// @bundles <relPath>` annotation (and optional `// @external …`).
 *
 * For each annotated test:
 *   1. Build the annotated source into a unique bundle under
 *      `.test-bundles/`, with leaf node_modules deps + any `@external`
 *      relative paths kept as runtime imports (the bundle's `import …
 *      from "pg"` and `import … from "/abs/path/to/sibling.ts"` stay).
 *   2. Record (source-abs-path → bundle-abs-path) in a manifest.
 *
 * Then write a preload script that registers
 *   `mock.module(<source-abs-path>, () => import(<bundle-abs-path>))`
 * for every entry. When the test's natural `import { foo } from
 * "./source"` is resolved by bun, it lands on the same abs path, hits
 * the synthetic mock, and returns the bundle's exports instead of
 * loading the real source.
 *
 * Mock isolation across tests in one `bun test` process: each bundle
 * lives at a unique path, so two tests covering the same source
 * import the same bundle module — but the bundle's body still runs
 * exactly once. For DIFFERENT sources, each bundle is its own ESM
 * module record and captures its own leaf-dep mocks at first load via
 * static binding. The test's `mock.module("pg", …)` is hoisted by
 * bun:test to before its own imports, so by the time the source
 * import (redirected to the bundle) loads, the leaf-dep mock is live.
 *
 * Wired into package.json as `bun run test:bundled`.
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

  // 1. Discover bundled tests under src/. The `.test.bundle.ts` suffix
  // keeps them OUT of the default `*.test.ts` glob that
  // `bun run test:non-bundled` uses — so each test file runs under
  // exactly the runner that supplies the preload it expects.
  const testFiles: string[] = [];
  const glob = new Glob("**/*.test.bundle.{ts,tsx}");
  for await (const rel of glob.scan({ cwd: resolve(REPO_ROOT, "src"), absolute: false })) {
    testFiles.push(resolve(REPO_ROOT, "src", rel));
  }

  const manifest: Array<{ test: string; source: string; external: string[]; bundle: string }> = [];
  for (const testAbs of testFiles) {
    const ann = await parseAnnotations(testAbs);
    if (!ann.bundles) continue;
    const sourceAbs = resolve(REPO_ROOT, ann.bundles);
    manifest.push({
      test: testAbs,
      source: sourceAbs,
      external: ann.external,
      bundle: bundlePathFor(sourceAbs),
    });
  }

  if (manifest.length === 0) {
    process.stdout.write("no bundled tests discovered (looking for `// @bundles <relPath>`)\n");
    return;
  }

  process.stdout.write(
    `${COLOR_BOLD}building${COLOR_RESET} ${manifest.length} bundle(s)…\n`,
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
  const preloadBody =
    `import { mock } from "bun:test";\n` +
    REAL_BARRELS.map((b) => `import * as __${b} from ${JSON.stringify(b)};`).join("\n") +
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

  process.stdout.write(
    `${COLOR_DIM}built ${manifest.length} bundles in ${buildMs.toFixed(0)}ms${COLOR_RESET}\n`,
  );

  // 4. Run the bundled tests in ONE bun test process with the preload.
  const t2 = performance.now();
  const proc = Bun.spawn(
    ["bun", "test", "--preload", preloadPath, ...manifest.map((m) => m.test)],
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
