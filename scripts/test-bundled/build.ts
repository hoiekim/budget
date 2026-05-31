/**
 * Bundle builder for per-test-bundle isolation.
 *
 * For each test the orchestrator finds, take the annotated source file
 * and produce a UNIQUE bundle in `.test-bundles/`. Leaf node_modules
 * deps that tests mock are kept external by default; additional
 * relative-path externals (e.g. a sibling module the test mocks) are
 * marked via the test's `// @external <relPath>` annotation and
 * resolved to absolute paths by a Bun plugin so the test can mock at
 * the same absolute path.
 */
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import type { BunPlugin } from "bun";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const BUNDLE_DIR = resolve(REPO_ROOT, ".test-bundles");

/** node_modules packages that tests commonly mock at the leaf level. */
const DEFAULT_NODE_EXTERNALS = [
  "pg",
  "bcrypt",
  "jose",
  "plaid",
  "aws-sdk",
  "nock",
  "mock-aws-s3",
];

export interface BuildOptions {
  /** Absolute path to the source `*.ts` file being bundled. */
  source: string;
  /**
   * Specifiers that should stay external in the bundle so the test can
   * mock them. Each entry is either a relative path (`./foo`, `../bar`)
   * resolved against `source`, or a tsconfig-aliased specifier
   * (`common`, `server/lib/postgres/models`, …) resolved through the
   * paths table. The plugin rewrites each emitted import to the
   * resolved absolute path so the bundle's runtime import and the
   * test's `mock.module()` use the same key.
   */
  externalSpecs?: string[];
}

export interface BuildResult {
  source: string;
  bundlePath: string;
  /** map of relative-spec → resolved-absolute-path for tests to mock. */
  externalResolutions: Record<string, string>;
  buildMs: number;
}

/**
 * Try to resolve a base path with the standard extensions tsconfig uses.
 * Returns the first existing `.ts(x)` (or `/index.ts(x)`) candidate, or
 * null if nothing resolves. Used by both relative and aliased lookups.
 *
 * If `base` already carries a `.ts`/`.tsx` extension and exists as-is
 * (which a tsconfig path alias targeting a specific file like
 * `"test-bundled": ["../scripts/test-bundled/runtime.ts"]` produces),
 * return it directly instead of appending another extension.
 */
const tryExts = (base: string): string | null => {
  if (base.match(/\.tsx?$/) && existsSync(base)) return base;
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    resolve(base, "index.ts"),
    resolve(base, "index.tsx"),
  ];
  for (const c of candidates) {
    if (existsSync(c) && c.match(/\.tsx?$/)) return c;
  }
  return null;
};

/** Parsed prefix → target list from tsconfig "compilerOptions.paths". */
type PathAliasTable = Array<{ prefix: string; isWildcard: boolean; targets: string[] }>;

let _aliasTable: PathAliasTable | null = null;
let _baseUrl: string | null = null;

const loadTsConfigPaths = (): { table: PathAliasTable; baseUrl: string } => {
  if (_aliasTable && _baseUrl) return { table: _aliasTable, baseUrl: _baseUrl };
  const tsconfigPath = resolve(REPO_ROOT, "tsconfig.json");
  // Strip JSON comments (tsconfig allows them; node's JSON.parse doesn't).
  const raw = require("node:fs").readFileSync(tsconfigPath, "utf8").replace(/^\s*\/\/.*$/gm, "");
  const cfg = JSON.parse(raw);
  const co = cfg.compilerOptions ?? {};
  const baseUrl = resolve(REPO_ROOT, co.baseUrl ?? ".");
  const paths = (co.paths ?? {}) as Record<string, string[]>;
  const table: PathAliasTable = [];
  for (const [prefix, targets] of Object.entries(paths)) {
    if (prefix.endsWith("/*")) {
      table.push({ prefix: prefix.slice(0, -1), isWildcard: true, targets });
    } else {
      table.push({ prefix, isWildcard: false, targets });
    }
  }
  // Sort so longer/more-specific prefixes win when overlapping.
  table.sort((a, b) => b.prefix.length - a.prefix.length);
  _aliasTable = table;
  _baseUrl = baseUrl;
  return { table, baseUrl };
};

const resolveAliasedSource = (spec: string): string | null => {
  const { table, baseUrl } = loadTsConfigPaths();
  for (const entry of table) {
    if (entry.isWildcard) {
      if (!spec.startsWith(entry.prefix)) continue;
      const tail = spec.slice(entry.prefix.length);
      for (const target of entry.targets) {
        const targetTail = target.endsWith("/*") ? target.slice(0, -2) : target;
        const base = resolve(baseUrl, targetTail, tail);
        const hit = tryExts(base);
        if (hit) return hit;
      }
    } else {
      if (spec !== entry.prefix) continue;
      for (const target of entry.targets) {
        const base = resolve(baseUrl, target);
        const hit = tryExts(base);
        if (hit) return hit;
      }
    }
  }
  return null;
};

/**
 * Resolve a relative import specifier against an importer file. Tries
 * `.ts`, `.tsx`, then `/index.ts` so the result matches what bun's loader
 * would pick. Returns null if nothing resolves.
 */
const resolveRelativeSource = (importer: string, spec: string): string | null => {
  const base = resolve(dirname(importer), spec);
  return tryExts(base);
};

/**
 * Resolve any `@external` specifier — relative (`./foo`, `../bar`) or
 * tsconfig-aliased (`common`, `server/lib/postgres/models`, …) — to its
 * absolute source-file path. Returns null if neither path resolves.
 */
const resolveExternalSpec = (importer: string, spec: string): string | null => {
  if (spec.startsWith(".")) return resolveRelativeSource(importer, spec);
  return resolveAliasedSource(spec);
};

/**
 * Bun plugin: for each `@external` entry — whether relative or
 * tsconfig-aliased — intercept the resolver, return the absolute source
 * path with `external: true`. The bundle then emits `import … from
 * "/abs/path/to/source.ts"` and the test's `mock.module(<spec>, …)`
 * matches it (bun resolves the test's spec to the same abs path).
 */
const externalSpecsPlugin = (
  source: string,
  externalSpecs: string[],
  resolutions: Record<string, string>,
): BunPlugin => ({
  name: "external-specs",
  setup(build) {
    for (const spec of externalSpecs) {
      const abs = resolveExternalSpec(source, spec);
      if (!abs) {
        throw new Error(`@external "${spec}" did not resolve from ${source}`);
      }
      resolutions[spec] = abs;
      build.onResolve({ filter: new RegExp(`^${escapeRegex(spec)}$`) }, (args) => {
        // Skip if the importer is OUTSIDE the repo (e.g. node_modules
        // packages doing their own imports). The bundle's importers
        // are always under REPO_ROOT.
        if (!args.importer.startsWith(REPO_ROOT)) return undefined;
        return { path: abs, external: true };
      });
    }
  },
});

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Compute the bundle path for a given source. Path is flattened so
 * different sources never collide and tests can predict the path.
 */
export const bundlePathFor = (source: string): string => {
  const rel = source.startsWith(REPO_ROOT)
    ? source.slice(REPO_ROOT.length + 1)
    : source;
  const flat = rel.replace(/\.(ts|tsx)$/, "").replace(/[\/\\]/g, "__");
  return resolve(BUNDLE_DIR, `${flat}.bundle.js`);
};

/**
 * Rewrite the externalized specifiers in the bundle output to ABSOLUTE
 * source paths. Bun.build's `external: true` keeps the original
 * specifier in the emitted bundle, so a relative spec like
 * `./securities` would otherwise resolve relative to the bundle's
 * location (`.test-bundles/`) at runtime, and an aliased spec like
 * `common` would resolve via the runtime's path-mapping (or fail if
 * Bun isn't given the tsconfig context). Rewriting to the absolute
 * source path makes both cases deterministic and gives the test a
 * stable key — bun resolves the test's `mock.module(spec, …)` to the
 * same abs path, so the bundle's import and the test's mock match.
 */
const rewriteExternalImports = async (
  bundlePath: string,
  resolutions: Record<string, string>,
): Promise<void> => {
  if (Object.keys(resolutions).length === 0) return;
  let text = await readFile(bundlePath, "utf8");
  for (const [spec, abs] of Object.entries(resolutions)) {
    // Replace `from "./securities"` (and the single-quoted form) only
    // when it appears in an import/export-from clause. A bare string
    // match would catch unrelated mentions in comments or strings.
    const escSpec = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(from\\s+)(["'])${escSpec}\\2`, "g");
    text = text.replace(re, `$1$2${abs}$2`);
  }
  await writeFile(bundlePath, text);
};

export const buildBundle = async (options: BuildOptions): Promise<BuildResult> => {
  await mkdir(BUNDLE_DIR, { recursive: true });
  const bundlePath = bundlePathFor(options.source);
  const externalResolutions: Record<string, string> = {};

  const plugins =
    options.externalSpecs && options.externalSpecs.length > 0
      ? [externalSpecsPlugin(options.source, options.externalSpecs, externalResolutions)]
      : [];

  const t0 = performance.now();
  const result = await Bun.build({
    entrypoints: [options.source],
    outdir: BUNDLE_DIR,
    naming: bundlePath.split("/").pop()!,
    target: "bun",
    external: DEFAULT_NODE_EXTERNALS,
    format: "esm",
    plugins,
  });
  const buildMs = performance.now() - t0;

  if (!result.success) {
    const msgs = result.logs.map((l) => `  ${l.level}: ${l.message}`).join("\n");
    throw new Error(`bundle build failed for ${options.source}:\n${msgs}`);
  }

  await rewriteExternalImports(bundlePath, externalResolutions);

  return { source: options.source, bundlePath, externalResolutions, buildMs };
};

export const cleanBundleDir = async (): Promise<void> => {
  await rm(BUNDLE_DIR, { recursive: true, force: true });
};

export const getBundleDir = (): string => BUNDLE_DIR;
export const getRepoRoot = (): string => REPO_ROOT;
