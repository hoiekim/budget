/**
 * Per-test-bundle runner.
 *
 * For each converted test under `scripts/test-bundled/bundled-tests/`:
 *   1. Parse its `// @bundles <relPath>` and any `// @external <spec>`
 *      header annotations.
 *   2. Build the source into a unique bundle under `.test-bundles/`,
 *      keeping leaf node_modules deps (and any `@external` relative
 *      paths) as runtime imports so the test can mock them.
 *   3. Run all converted tests in ONE `bun test` invocation. Isolation
 *      comes from each test dynamic-importing its own unique bundle
 *      path — each bundle captures the leaf-dep mocks active at its
 *      first load, then never re-resolves them.
 *
 * Wired into package.json as `bun run test:bundled`.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Glob } from "bun";
import { buildBundle, cleanBundleDir, getRepoRoot } from "./build.ts";

const REPO_ROOT = getRepoRoot();
const BUNDLED_TESTS_DIR = resolve(import.meta.dirname, "bundled-tests");

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
    if (externalM) {
      out.external.push(externalM[1]);
    }
  }
  return out;
};

const COLOR_DIM = "\x1b[90m";
const COLOR_BOLD = "\x1b[1m";
const COLOR_RESET = "\x1b[0m";

const main = async (): Promise<void> => {
  const t0 = performance.now();
  const testFiles: string[] = [];
  const glob = new Glob("**/*.test.ts");
  for await (const rel of glob.scan({ cwd: BUNDLED_TESTS_DIR, absolute: false })) {
    testFiles.push(resolve(BUNDLED_TESTS_DIR, rel));
  }
  if (testFiles.length === 0) {
    process.stdout.write("no bundled tests discovered\n");
    return;
  }

  // Resolve annotations
  const manifest: Array<{ test: string; source: string; external: string[] }> = [];
  for (const testAbs of testFiles) {
    const ann = await parseAnnotations(testAbs);
    if (!ann.bundles) {
      process.stderr.write(`skip (no @bundles annotation): ${testAbs}\n`);
      continue;
    }
    const sourceAbs = resolve(REPO_ROOT, ann.bundles);
    manifest.push({ test: testAbs, source: sourceAbs, external: ann.external });
  }

  process.stdout.write(
    `${COLOR_BOLD}building${COLOR_RESET} ${manifest.length} bundle(s)…\n`,
  );

  await cleanBundleDir();
  const t1 = performance.now();
  await Promise.all(
    manifest.map((m) =>
      buildBundle({ source: m.source, externalRelatives: m.external }),
    ),
  );
  const buildMs = performance.now() - t1;
  process.stdout.write(
    `${COLOR_DIM}built ${manifest.length} bundles in ${buildMs.toFixed(0)}ms${COLOR_RESET}\n`,
  );

  // Run all converted tests in ONE bun test process
  const t2 = performance.now();
  const proc = Bun.spawn(["bun", "test", ...testFiles], {
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
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
