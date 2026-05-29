import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";

/**
 * A lazy, incrementally-patchable forward/reverse dep graph built from
 * `ts.preProcessFile` import scanning + `ts.resolveModuleName` resolution.
 *
 * Scope: TypeScript/TSX source files under the repo. Bare-package specifiers
 * (anything that doesn't resolve to a file inside the repo) are dropped —
 * watch-mode invalidation only cares about in-repo edges.
 *
 * Dynamic `import("…")` with a string-literal argument IS captured
 * (preProcessFile reports it via `importedFiles`). Non-literal dynamic
 * imports cannot be resolved statically and are silently skipped — callers
 * relying on them should add a `// @test preload=…` header instead.
 */
export class DepGraph {
  private compilerOptions: ts.CompilerOptions;
  private repoRoot: string;
  /** file → set of in-repo files it imports (forward edges). */
  private forward = new Map<string, Set<string>>();
  /** file → set of in-repo files that import it (reverse edges). */
  private reverse = new Map<string, Set<string>>();
  /** Files that have been parsed at least once and are in `forward`. */
  private parsed = new Set<string>();

  constructor(repoRoot: string, compilerOptions: ts.CompilerOptions) {
    this.repoRoot = repoRoot;
    this.compilerOptions = compilerOptions;
  }

  /** Parse a file (if not already cached) and patch the graph. */
  ensureParsed(filePath: string): void {
    if (this.parsed.has(filePath)) return;
    this.refresh(filePath);
  }

  /**
   * Re-parse a file; diff its outgoing edges against the cached set and
   * patch both `forward` and `reverse`. Idempotent.
   */
  refresh(filePath: string): void {
    const newImports = this.scan(filePath);
    const oldImports = this.forward.get(filePath) ?? new Set<string>();
    for (const old of oldImports) {
      if (!newImports.has(old)) {
        const set = this.reverse.get(old);
        if (set) {
          set.delete(filePath);
          if (set.size === 0) this.reverse.delete(old);
        }
      }
    }
    for (const next of newImports) {
      if (!oldImports.has(next)) {
        let set = this.reverse.get(next);
        if (!set) {
          set = new Set();
          this.reverse.set(next, set);
        }
        set.add(filePath);
      }
    }
    this.forward.set(filePath, newImports);
    this.parsed.add(filePath);
  }

  /** Remove a file from the graph (e.g. when it's deleted on disk). */
  remove(filePath: string): void {
    const outgoing = this.forward.get(filePath);
    if (outgoing) {
      for (const target of outgoing) {
        const set = this.reverse.get(target);
        if (set) {
          set.delete(filePath);
          if (set.size === 0) this.reverse.delete(target);
        }
      }
    }
    this.forward.delete(filePath);
    const incoming = this.reverse.get(filePath);
    if (incoming) {
      for (const importer of incoming) {
        const set = this.forward.get(importer);
        if (set) set.delete(filePath);
      }
    }
    this.reverse.delete(filePath);
    this.parsed.delete(filePath);
  }

  /**
   * BFS over the reverse graph from `changed`. Returns the set of files
   * that transitively depend on it (including `changed` itself).
   */
  affected(changed: string): Set<string> {
    const out = new Set<string>([changed]);
    const queue: string[] = [changed];
    while (queue.length > 0) {
      const next = queue.shift()!;
      const importers = this.reverse.get(next);
      if (!importers) continue;
      for (const importer of importers) {
        if (out.has(importer)) continue;
        out.add(importer);
        queue.push(importer);
      }
    }
    return out;
  }

  /** Build the forward graph eagerly from a starting set of files (BFS). */
  buildFrom(seeds: string[]): void {
    const queue: string[] = [...seeds];
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (this.parsed.has(next)) continue;
      this.refresh(next);
      const outgoing = this.forward.get(next);
      if (outgoing) for (const t of outgoing) queue.push(t);
    }
  }

  private scan(filePath: string): Set<string> {
    const out = new Set<string>();
    let text: string;
    try {
      text = readFileSync(filePath, "utf8");
    } catch {
      return out;
    }
    const info = ts.preProcessFile(text, true, true);
    const specifiers = new Set<string>();
    for (const ref of info.importedFiles) specifiers.add(ref.fileName);
    for (const ref of info.referencedFiles) specifiers.add(ref.fileName);
    for (const spec of specifiers) {
      const resolved = ts.resolveModuleName(
        spec,
        filePath,
        this.compilerOptions,
        ts.sys,
      ).resolvedModule?.resolvedFileName;
      if (!resolved) continue;
      const abs = resolve(dirname(filePath), resolved);
      if (!abs.startsWith(this.repoRoot)) continue;
      if (abs.includes("/node_modules/")) continue;
      out.add(abs);
    }
    return out;
  }
}

/**
 * Load tsconfig.json from `repoRoot` and return parsed compiler options.
 * Falls back to a minimal set if tsconfig is missing.
 */
export const loadCompilerOptions = (repoRoot: string): ts.CompilerOptions => {
  const tsconfigPath = ts.findConfigFile(repoRoot, ts.sys.fileExists, "tsconfig.json");
  if (!tsconfigPath) return { allowJs: true, baseUrl: repoRoot };
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repoRoot);
  // `moduleResolution: "bundler"` is supported by ts.resolveModuleName via
  // ModuleResolutionKind.Bundler — keep whatever the tsconfig says.
  return parsed.options;
};
