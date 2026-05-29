import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { Glob } from "bun";
import type { Config, ModuleConfig } from "./config.ts";

export interface DiscoveredFile {
  /** Absolute path. */
  path: string;
  /** Repo-root-relative POSIX path. */
  relPath: string;
  /** Resolved preload paths (absolute), in declaration order, de-duplicated. */
  preload: string[];
  /** Name of the matched module, or undefined if outside every module pattern. */
  module?: string;
}

const HEADER_LINES_SCAN = 10;
const HEADER_RE = /^\s*\/\/\s*@test\s+(.+)$/;

/**
 * Parse the `// @test key=val,val2` header from the first N lines of a file.
 * Returns the additional preload paths declared via the header.
 *
 * Example: `// @test preload=fixtures/foo.ts,fixtures/bar.ts`
 */
const parseFileHeader = async (absPath: string): Promise<string[]> => {
  let text: string;
  try {
    text = await readFile(absPath, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n", HEADER_LINES_SCAN);
  const extra: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (!trimmed.startsWith("//")) break;
    const m = HEADER_RE.exec(line);
    if (!m) continue;
    for (const pair of m[1].split(/\s+/)) {
      const [k, v] = pair.split("=", 2);
      if (k === "preload" && v) extra.push(...v.split(",").map((s) => s.trim()).filter(Boolean));
    }
  }
  return extra;
};

const matchModule = (
  relPath: string,
  modules: Record<string, ModuleConfig>,
): { name: string; module: ModuleConfig } | undefined => {
  for (const [name, module] of Object.entries(modules)) {
    const patterns = Array.isArray(module.pattern) ? module.pattern : [module.pattern];
    for (const pat of patterns) {
      const g = new Glob(pat);
      if (g.match(relPath)) return { name, module };
    }
  }
  return undefined;
};

/**
 * Discover all `*.test.ts(x)` files under `targets` (or under `src/` if none),
 * resolve each file's preload list (module-level + per-file header), and
 * return them sorted by path for stable ordering.
 */
export const discoverTests = async (
  repoRoot: string,
  config: Config,
  targets: string[],
): Promise<DiscoveredFile[]> => {
  const roots = targets.length === 0 ? ["src"] : targets;
  const found = new Set<string>();
  for (const t of roots) {
    const abs = resolve(repoRoot, t);
    try {
      const stat = await Bun.file(abs).stat();
      if (stat.isFile()) {
        if (/\.test\.tsx?$/.test(abs)) found.add(abs);
        continue;
      }
    } catch {
      continue;
    }
    const glob = new Glob("**/*.test.{ts,tsx}");
    for await (const rel of glob.scan({ cwd: abs, absolute: false })) {
      found.add(resolve(abs, rel));
    }
  }

  const discovered: DiscoveredFile[] = [];
  for (const absPath of found) {
    const relPath = relative(repoRoot, absPath).replace(/\\/g, "/");
    const matched = matchModule(relPath, config.modules);
    const modulePreload = matched ? matched.module.preload : [];
    const headerPreload = await parseFileHeader(absPath);
    const preloadSet = new Set<string>();
    const preloadOrdered: string[] = [];
    for (const p of [...modulePreload, ...headerPreload]) {
      const absP = resolve(repoRoot, p);
      if (preloadSet.has(absP)) continue;
      preloadSet.add(absP);
      preloadOrdered.push(absP);
    }
    discovered.push({
      path: absPath,
      relPath,
      preload: preloadOrdered,
      module: matched?.name,
    });
  }
  discovered.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return discovered;
};
