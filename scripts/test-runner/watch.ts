import { watch } from "node:fs";
import { resolve, relative } from "node:path";
import { Glob } from "bun";
import type { Config } from "./config.ts";
import type { DiscoveredFile } from "./discover.ts";
import { discoverTests } from "./discover.ts";
import type { DepGraph } from "./dep-graph.ts";
import { runPool, defaultProgressReporter, cleanupRunDir } from "./pool.ts";
import { formatSummary } from "./reporter.ts";

interface WatchOptions {
  repoRoot: string;
  config: Config;
  graph: DepGraph;
  parallelism: number;
  /** Initial discovery — used to map paths back to per-file preload lists. */
  discovered: DiscoveredFile[];
}

const DEBOUNCE_MS = 100;

const COLOR_DIM = "\x1b[90m";
const COLOR_RESET = "\x1b[0m";
const COLOR_BOLD = "\x1b[1m";

const isIgnored = (relPath: string, patterns: string[]): boolean => {
  for (const p of patterns) {
    const g = new Glob(p);
    if (g.match(relPath)) return true;
  }
  return false;
};

/**
 * Start the watch loop. Returns a promise that never resolves naturally —
 * the caller should run this until Ctrl-C.
 *
 * On each batch of file changes:
 *   1. Patch the dep graph for changed source files.
 *   2. Walk the reverse graph to find every test file transitively affected.
 *   3. If a *test* file itself was changed (or added), include it directly.
 *   4. Run the affected subset through `runPool`.
 */
export const runWatch = async (options: WatchOptions): Promise<void> => {
  const { repoRoot, config, graph, parallelism } = options;
  let discovered = options.discovered;
  const byPath = new Map<string, DiscoveredFile>();
  for (const f of discovered) byPath.set(f.path, f);

  const pendingChanges = new Set<string>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;

  process.stdout.write(`${COLOR_BOLD}watching${COLOR_RESET} ${COLOR_DIM}${repoRoot}${COLOR_RESET}\n`);
  process.stdout.write(`${COLOR_DIM}(press Ctrl-C to stop)${COLOR_RESET}\n\n`);

  const isTestFile = (absPath: string): boolean =>
    /\.test\.tsx?$/.test(absPath) && absPath.startsWith(resolve(repoRoot, "src"));

  const refreshDiscovered = async (): Promise<void> => {
    discovered = await discoverTests(repoRoot, config, []);
    byPath.clear();
    for (const f of discovered) byPath.set(f.path, f);
  };

  const processBatch = async (): Promise<void> => {
    if (pendingChanges.size === 0) return;
    const changed = Array.from(pendingChanges);
    pendingChanges.clear();

    const affectedTestFiles = new Set<string>();
    let needRediscover = false;
    for (const abs of changed) {
      if (isTestFile(abs) && !byPath.has(abs)) needRediscover = true;
    }
    if (needRediscover) await refreshDiscovered();

    for (const abs of changed) {
      // Patch the graph for any in-repo file change.
      graph.refresh(abs);
      const reverse = graph.affected(abs);
      for (const dep of reverse) if (isTestFile(dep)) affectedTestFiles.add(dep);
      if (isTestFile(abs)) affectedTestFiles.add(abs);
    }

    const toRun: DiscoveredFile[] = [];
    for (const abs of affectedTestFiles) {
      const f = byPath.get(abs);
      if (f) toRun.push(f);
    }

    if (toRun.length === 0) {
      process.stdout.write(
        `${COLOR_DIM}no tests affected by ${changed.length} change(s)${COLOR_RESET}\n\n`,
      );
      return;
    }

    process.stdout.write(
      `${COLOR_BOLD}re-running ${toRun.length} affected test file(s)${COLOR_RESET}\n`,
    );
    const start = performance.now();
    const { results, runRoot } = await runPool(toRun, {
      repoRoot,
      parallelism,
      coverage: false,
      onProgress: defaultProgressReporter,
    });
    const totalMs = performance.now() - start;
    process.stdout.write(`\n${formatSummary(results, totalMs)}\n\n`);
    await cleanupRunDir(runRoot);
  };

  const enqueue = (abs: string): void => {
    pendingChanges.add(abs);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      // Serialize: if a run is in flight, queue the next one to start after.
      const start = inFlight ? inFlight.then(processBatch) : processBatch();
      inFlight = start.catch((err) => {
        process.stderr.write(`watch error: ${err}\n`);
      });
    }, DEBOUNCE_MS);
  };

  const srcRoot = resolve(repoRoot, "src");
  const makeChangeHandler =
    (base: string) =>
    (eventType: string, filename: string | null): void => {
      void eventType;
      if (!filename) return;
      const abs = resolve(base, filename);
      const rel = relative(repoRoot, abs).replace(/\\/g, "/");
      if (isIgnored(rel, config.watch.ignore)) return;
      if (!/\.(ts|tsx|js|jsx|json)$/.test(abs)) return;
      enqueue(abs);
    };

  // `fs.watch` recursive is supported on macOS + Windows. On Linux it
  // silently ignores `recursive: true` and only watches the top directory;
  // we'd need chokidar/fsevents for true cross-platform support. The dev
  // box is macOS — accept the macOS-only path here and note it.
  // fs.watch passes `filename` relative to the watched directory, so the
  // src-watcher resolves against `srcRoot` and the test.config watcher
  // against `repoRoot`.
  const watcher = watch(srcRoot, { recursive: true }, makeChangeHandler(srcRoot));
  const testConfigWatcher = watch(
    resolve(repoRoot, "test.config.ts"),
    makeChangeHandler(repoRoot),
  );

  await new Promise<void>(() => {
    process.on("SIGINT", () => {
      watcher.close();
      testConfigWatcher.close();
      process.exit(0);
    });
  });
};
