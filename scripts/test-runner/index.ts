/**
 * Custom test runner for the budget repo.
 *
 * Each `*.test.ts(x)` file runs in its own `bun test` subprocess so
 * `mock.module()` is local to that file — no global pollution. Subprocess
 * pool runs files in parallel; coverage is merged across processes.
 *
 * Usage:
 *   bun scripts/test-runner/index.ts                         # all tests
 *   bun scripts/test-runner/index.ts src/server              # subset
 *   bun scripts/test-runner/index.ts src/server/foo.test.ts  # one file
 *   bun scripts/test-runner/index.ts --watch                 # watch mode
 *   bun scripts/test-runner/index.ts --coverage              # with LCOV merge
 *   bun scripts/test-runner/index.ts -p 4                    # parallelism = 4
 *
 * Plumbed through package.json as `bun run test:next`.
 */
import { parseArgs } from "node:util";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, resolveParallelism } from "./config.ts";
import { discoverTests } from "./discover.ts";
import { DepGraph, loadCompilerOptions } from "./dep-graph.ts";
import { runPool, defaultProgressReporter, cleanupRunDir } from "./pool.ts";
import { formatSummary } from "./reporter.ts";
import { mergeCoverage } from "./coverage.ts";
import { runWatch } from "./watch.ts";

const main = async (): Promise<void> => {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      watch: { type: "boolean", default: false },
      coverage: { type: "boolean", default: false },
      parallelism: { type: "string", short: "p" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(
      `usage: test-runner [options] [target ...]\n` +
        `  --watch              re-run affected tests on file change\n` +
        `  --coverage           emit merged LCOV at coverage/lcov.info\n` +
        `  -p, --parallelism N  worker pool size (default: cpu count)\n`,
    );
    return;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..");

  const config = await loadConfig(repoRoot);
  const parallelism = values.parallelism
    ? resolveParallelism(Number(values.parallelism))
    : resolveParallelism(config.parallelism);

  const discovered = await discoverTests(repoRoot, config, positionals);
  if (discovered.length === 0) {
    process.stdout.write("no test files matched\n");
    return;
  }

  process.stdout.write(
    `running ${discovered.length} test file(s) at parallelism=${parallelism}` +
      (values.coverage ? " with coverage" : "") +
      "\n",
  );

  const compilerOptions = loadCompilerOptions(repoRoot);
  const graph = new DepGraph(repoRoot, compilerOptions);
  // Build the graph eagerly from all discovered test files. Watch mode
  // needs the reverse graph to map source-file changes to affected tests;
  // run-once mode doesn't strictly need it but the cost is small and it
  // surfaces parse errors early.
  graph.buildFrom(discovered.map((d) => d.path));

  if (values.watch) {
    // Run once first, then watch.
    const start = performance.now();
    const { results, runRoot } = await runPool(discovered, {
      repoRoot,
      parallelism,
      coverage: false,
      onProgress: defaultProgressReporter,
    });
    const totalMs = performance.now() - start;
    process.stdout.write(`\n${formatSummary(results, totalMs)}\n\n`);
    await cleanupRunDir(runRoot);
    await runWatch({ repoRoot, config, graph, parallelism, discovered });
    return;
  }

  const start = performance.now();
  const { results, workerCoverageDirs, runRoot } = await runPool(discovered, {
    repoRoot,
    parallelism,
    coverage: values.coverage,
    onProgress: defaultProgressReporter,
  });
  const totalMs = performance.now() - start;
  process.stdout.write(`\n${formatSummary(results, totalMs)}\n`);

  if (values.coverage) {
    const outPath = join(repoRoot, "coverage", "lcov.info");
    await mergeCoverage(
      workerCoverageDirs,
      outPath,
      repoRoot,
      config.coverage.include,
      config.coverage.exclude,
    );
    process.stdout.write(`coverage → ${outPath}\n`);
  }

  await cleanupRunDir(runRoot);

  const anyFail = results.some((r) => r.exitCode !== 0 || r.cases.some((c) => c.status === "fail"));
  process.exit(anyFail ? 1 : 0);
};

main().catch((err) => {
  process.stderr.write(`test-runner crashed: ${err?.stack ?? err}\n`);
  process.exit(2);
});
