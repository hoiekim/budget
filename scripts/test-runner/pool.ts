import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DiscoveredFile } from "./discover.ts";
import { parseJUnitXml, type FileResult } from "./reporter.ts";

export interface PoolOptions {
  repoRoot: string;
  parallelism: number;
  coverage: boolean;
  /** Called once per file as it completes (used for streaming progress). */
  onProgress?: (result: FileResult, index: number, total: number) => void;
}

export interface PoolResult {
  results: FileResult[];
  /** Per-file coverage output dirs (only populated when coverage=true). */
  workerCoverageDirs: string[];
  /** Tempdir holding per-file junit/coverage subdirs; clean up after merge. */
  runRoot: string;
}

const COLOR_DIM = "\x1b[90m";
const COLOR_GREEN = "\x1b[32m";
const COLOR_RED = "\x1b[31m";
const COLOR_RESET = "\x1b[0m";

/**
 * Spawn `bun test <file>` once per discovered file, up to `parallelism` in
 * flight. Each subprocess is fully isolated (fresh module cache, no shared
 * mock state). Results are returned in the same order as `files`.
 */
export const runPool = async (
  files: DiscoveredFile[],
  options: PoolOptions,
): Promise<PoolResult> => {
  const runRoot = join(tmpdir(), `bun-test-runner-${Date.now()}-${process.pid}`);
  await mkdir(runRoot, { recursive: true });
  const workerCoverageDirs: string[] = [];

  const results: FileResult[] = new Array(files.length);
  let nextIndex = 0;
  let completed = 0;

  const runOne = async (fileIndex: number): Promise<void> => {
    const file = files[fileIndex];
    const fileRoot = join(runRoot, `f${fileIndex}`);
    await mkdir(fileRoot, { recursive: true });
    const junitPath = join(fileRoot, "report.xml");
    const coverageDir = options.coverage ? join(fileRoot, "coverage") : undefined;
    if (coverageDir) await mkdir(coverageDir, { recursive: true });

    const args = ["test", file.path];
    for (const p of file.preload) {
      args.push("--preload", p);
    }
    args.push("--reporter=junit", `--reporter-outfile=${junitPath}`);
    if (coverageDir) {
      args.push("--coverage", "--coverage-reporter=lcov", `--coverage-dir=${coverageDir}`);
    }

    const start = performance.now();
    const proc = Bun.spawn(["bun", ...args], {
      cwd: options.repoRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const durationMs = performance.now() - start;

    const cases = await parseJUnitXml(junitPath);
    const result: FileResult = {
      relPath: file.relPath,
      exitCode,
      durationMs,
      cases,
      output: exitCode !== 0 ? `${stdout}\n${stderr}` : undefined,
    };
    results[fileIndex] = result;
    if (coverageDir) workerCoverageDirs.push(coverageDir);

    completed++;
    if (options.onProgress) options.onProgress(result, completed, files.length);
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(options.parallelism, files.length); i++) {
    workers.push(
      (async () => {
        while (true) {
          const idx = nextIndex++;
          if (idx >= files.length) return;
          await runOne(idx);
        }
      })(),
    );
  }
  await Promise.all(workers);

  return { results, workerCoverageDirs, runRoot };
};

export const defaultProgressReporter = (
  result: FileResult,
  index: number,
  total: number,
): void => {
  const ok = result.exitCode === 0 && !result.cases.some((c) => c.status === "fail");
  const mark = ok ? `${COLOR_GREEN}✓${COLOR_RESET}` : `${COLOR_RED}✗${COLOR_RESET}`;
  const pad = String(index).padStart(String(total).length, " ");
  const ms = `${COLOR_DIM}${result.durationMs.toFixed(0)}ms${COLOR_RESET}`;
  process.stdout.write(`  ${mark} [${pad}/${total}] ${result.relPath} ${ms}\n`);
};

export const cleanupRunDir = async (dir: string): Promise<void> => {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
};
