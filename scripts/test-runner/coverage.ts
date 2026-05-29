import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/**
 * LCOV merge: union of records across subprocess outputs.
 *
 * Bun's `--coverage-reporter=lcov` emits a slimmed LCOV: `SF:` for the
 * source file, `DA:<line>,<hits>` for each executed line, and AGGREGATE
 * `FNF:` / `FNH:` / `LF:` / `LH:` counters per file. It does NOT emit
 * `FN:` / `FNDA:` records (per-function names + hit counts) nor branch
 * data. So we merge what we get:
 *
 *   DA       — sum hit counts per (file, line); recompute LF/LH from it.
 *   FNF      — same per-file across procs (it's static); take any non-zero.
 *   FNH      — take the MAX across procs. If two procs hit disjoint
 *              function sets in the same file (rare in practice — each
 *              test file usually drives one module), this undercounts.
 *              Bun would need to emit FN:/FNDA: records for a precise
 *              merge; tracked as a future enhancement.
 */

interface FileRecord {
  sf: string;
  /** line → summed hit count across procs */
  da: Map<number, number>;
  /** functions found in file (static; max across procs to be safe) */
  fnf: number;
  /** functions hit (max across procs — approximate) */
  fnh: number;
}

const parseLcovText = (text: string, into: Map<string, FileRecord>): void => {
  let current: FileRecord | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "end_of_record") {
      current = null;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const tag = line.slice(0, colon);
    const value = line.slice(colon + 1);
    if (tag === "SF") {
      let rec = into.get(value);
      if (!rec) {
        rec = { sf: value, da: new Map(), fnf: 0, fnh: 0 };
        into.set(value, rec);
      }
      current = rec;
    } else if (current && tag === "DA") {
      const [ln, hit] = value.split(",");
      const n = Number(ln);
      const h = Number(hit);
      current.da.set(n, (current.da.get(n) ?? 0) + h);
    } else if (current && tag === "FNF") {
      current.fnf = Math.max(current.fnf, Number(value));
    } else if (current && tag === "FNH") {
      current.fnh = Math.max(current.fnh, Number(value));
    }
  }
};

const formatLcov = (records: Map<string, FileRecord>): string => {
  const out: string[] = [];
  for (const rec of records.values()) {
    out.push("TN:");
    out.push(`SF:${rec.sf}`);
    out.push(`FNF:${rec.fnf}`);
    out.push(`FNH:${rec.fnh}`);
    let lf = 0;
    let lh = 0;
    for (const [line, hit] of rec.da) {
      out.push(`DA:${line},${hit}`);
      lf++;
      if (hit > 0) lh++;
    }
    out.push(`LF:${lf}`);
    out.push(`LH:${lh}`);
    out.push("end_of_record");
  }
  return out.join("\n") + "\n";
};

const matchesAny = (path: string, patterns: string[]): boolean => {
  for (const p of patterns) {
    const g = new Bun.Glob(p);
    if (g.match(path)) return true;
  }
  return false;
};

/**
 * Merge every `<dir>/lcov.info` from the per-file coverage dirs, apply
 * include/exclude filters (paths are repo-root-relative), and write the
 * merged result to `outPath`.
 */
export const mergeCoverage = async (
  workerDirs: string[],
  outPath: string,
  repoRoot: string,
  include: string[],
  exclude: string[],
): Promise<void> => {
  const records = new Map<string, FileRecord>();
  for (const dir of workerDirs) {
    const file = join(dir, "lcov.info");
    if (!existsSync(file)) continue;
    const text = await readFile(file, "utf8");
    parseLcovText(text, records);
  }

  const filtered = new Map<string, FileRecord>();
  for (const [sf, rec] of records) {
    const rel = relative(repoRoot, sf).replace(/\\/g, "/");
    if (include.length > 0 && !matchesAny(rel, include)) continue;
    if (matchesAny(rel, exclude)) continue;
    filtered.set(sf, rec);
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, formatLcov(filtered));
};
