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
   * Relative-path imports (relative to `source`) that should stay
   * external so the test can mock them. The plugin rewrites each to the
   * resolved absolute path so the bundle's runtime import + the test's
   * `mock.module()` use the same key.
   */
  externalRelatives?: string[];
}

export interface BuildResult {
  source: string;
  bundlePath: string;
  /** map of relative-spec → resolved-absolute-path for tests to mock. */
  externalResolutions: Record<string, string>;
  buildMs: number;
}

/**
 * Resolve a relative import specifier against an importer file. Tries
 * `.ts`, `.tsx`, then `/index.ts` so the result matches what bun's loader
 * would pick. Returns null if nothing resolves.
 */
const resolveRelativeSource = (importer: string, spec: string): string | null => {
  const baseDir = dirname(importer);
  const baseNoExt = resolve(baseDir, spec);
  const candidates = [
    baseNoExt,
    `${baseNoExt}.ts`,
    `${baseNoExt}.tsx`,
    resolve(baseNoExt, "index.ts"),
    resolve(baseNoExt, "index.tsx"),
  ];
  for (const c of candidates) {
    if (existsSync(c) && !c.endsWith("/")) {
      // existsSync returns true for dirs too; prefer file matches.
      const stat = Bun.file(c);
      if (stat && c.match(/\.tsx?$/)) return c;
    }
  }
  return null;
};

/**
 * Bun plugin: for each `externalRelatives` entry, intercept the
 * resolver, return the absolute source path with `external: true`.
 * The bundle then emits `import … from "/abs/path/to/sibling.ts"` and
 * the test's `mock.module("/abs/path/to/sibling.ts", …)` matches it.
 */
const externalRelativesPlugin = (
  source: string,
  externalRelatives: string[],
  resolutions: Record<string, string>,
): BunPlugin => ({
  name: "external-relative-paths",
  setup(build) {
    for (const spec of externalRelatives) {
      const abs = resolveRelativeSource(source, spec);
      if (!abs) {
        throw new Error(`@external "${spec}" did not resolve from ${source}`);
      }
      resolutions[spec] = abs;
      build.onResolve({ filter: new RegExp(`^${escapeRegex(spec)}$`) }, (args) => {
        // Only externalize when the importer is THIS bundle's tree —
        // bun also asks us to resolve `node_modules` imports through
        // here; filter by checking that the importer is under repo.
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
 * Rewrite the externalized relative-path imports in the bundle output
 * to ABSOLUTE source paths. Bun.build's `external: true` keeps the
 * original specifier in the emitted bundle, so a relative spec like
 * `./securities` would otherwise resolve relative to the bundle's
 * location (`.test-bundles/`) at runtime — where the sibling doesn't
 * exist. Rewriting to the absolute source path also gives the test a
 * stable, predictable key to pass to `mock.module(...)`.
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
    options.externalRelatives && options.externalRelatives.length > 0
      ? [externalRelativesPlugin(options.source, options.externalRelatives, externalResolutions)]
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
