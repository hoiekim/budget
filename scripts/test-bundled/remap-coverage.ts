#!/usr/bin/env bun
/**
 * Remap lcov line-coverage from `.test-bundles/*.bundle.js` records
 * back to the originating `src/*.ts` source files, using the
 * `<bundle>.bundle.js.map` sourcemaps emitted by `Bun.build` (build.ts
 * sets `sourcemap: "external"`).
 *
 * Why: bun's `--coverage` reports `SF:.test-bundles/<test>__<source>.bundle.js`
 * for every bundled test — the source files that the test actually
 * exercises show 0/N functions hit, even though the test covers them
 * end-to-end. This script reads the sourcemap, maps each `DA:<gen_line>,<hits>`
 * back to `(source_abs_path, source_line)`, aggregates per source, and
 * emits a remapped lcov.info with source records.
 *
 * Function coverage (`FN:` / `FNDA:` entries) is NOT remapped — bun's
 * lcov only emits FNF/FNH totals without per-function line info, so we
 * can't attribute functions to source files. The line-coverage remap
 * is the meaningful gain.
 *
 * Usage: `bun scripts/test-bundled/remap-coverage.ts` — reads
 * `coverage/lcov.info`, writes `coverage/lcov.info` in place (after a
 * backup copy to `coverage/lcov.info.pre-remap`).
 */
import { readFile, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const LCOV_PATH = resolve(REPO_ROOT, "coverage/lcov.info");

// ── VLQ decoding for sourcemap mappings ──────────────────────────────────────
const VLQ_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const VLQ_INDEX: Record<string, number> = {};
for (let i = 0; i < VLQ_CHARS.length; i++) VLQ_INDEX[VLQ_CHARS[i]] = i;

/** Decode a single base64 VLQ run into signed integers. */
const decodeVlq = (s: string): number[] => {
  const out: number[] = [];
  let cur = 0;
  let shift = 0;
  for (let i = 0; i < s.length; i++) {
    const v = VLQ_INDEX[s[i]];
    if (v === undefined) throw new Error(`bad VLQ char: ${s[i]}`);
    cur |= (v & 0x1f) << shift;
    if (v & 0x20) {
      shift += 5;
    } else {
      const sign = cur & 1;
      // Use unsigned-right-shift to avoid 32-bit signed truncation on
      // segments wider than 31 bits (rare in practice but cheap insurance).
      const value = cur >>> 1;
      out.push(sign ? -value : value);
      cur = 0;
      shift = 0;
    }
  }
  return out;
};

interface SourceMap {
  version: number;
  sources: string[];
  mappings: string;
  sourceRoot?: string;
}

/**
 * Map generated lines (1-indexed) to source file + source line.
 * Returns a Map keyed on generated line, value `{ source, sourceLine }`
 * for the FIRST mapping on that line (sufficient for line-attribution).
 */
const parseMappings = (
  map: SourceMap,
): Map<number, { source: string; sourceLine: number }> => {
  const result = new Map<number, { source: string; sourceLine: number }>();
  let sourceIdx = 0;
  let sourceLine = 0;
  // (column / nameIdx tracked but not used downstream)
  // Each line in `mappings` is `;`-delimited; each segment is `,`-delimited.
  const lines = map.mappings.split(";");
  for (let genLine = 0; genLine < lines.length; genLine++) {
    let firstOnLine = true;
    if (!lines[genLine]) continue;
    for (const seg of lines[genLine].split(",")) {
      if (!seg) continue;
      const vals = decodeVlq(seg);
      // [genColumnDelta] OR
      // [genColumnDelta, sourceFileDelta, sourceLineDelta, sourceColumnDelta] OR
      // [..., nameDelta]
      // Column-only segments lack source info — skip.
      if (vals.length < 4) continue;
      sourceIdx += vals[1];
      sourceLine += vals[2];
      if (firstOnLine) {
        const source = map.sources[sourceIdx];
        if (source) {
          // genLine is 0-indexed in the mappings array; lcov DA: is 1-indexed.
          result.set(genLine + 1, { source, sourceLine: sourceLine + 1 });
        }
        firstOnLine = false;
      }
    }
  }
  return result;
};

// ── lcov record processing ───────────────────────────────────────────────────
interface SourceCoverage {
  /** line → max hits across all contributors (bundled + plain) */
  lines: Map<number, number>;
  /** verbatim FN:/FNDA: entries from any plain-side source record */
  fnEntries: string[];
  /** sum of FNF totals across plain-side records (bundle FNF is not
   *  remapped — see header comment for why) */
  fnf: number;
  fnh: number;
}

/** Records keyed by absolute source path. */
const sources = new Map<string, SourceCoverage>();

const getSource = (sourceAbs: string): SourceCoverage => {
  let cov = sources.get(sourceAbs);
  if (!cov) {
    cov = { lines: new Map(), fnEntries: [], fnf: 0, fnh: 0 };
    sources.set(sourceAbs, cov);
  }
  return cov;
};

const recordLineHit = (sourceAbs: string, line: number, hits: number) => {
  const cov = getSource(sourceAbs);
  // FIRST contribution: store as-is (including 0 hits, so the line
  // counts toward LF). LATER contributions: keep the max so a "hit"
  // from any test wins over "not hit" from another.
  const existing = cov.lines.get(line);
  if (existing === undefined || hits > existing) cov.lines.set(line, hits);
};

const remapBundleRecord = async (
  bundlePath: string,
  daEntries: Array<[number, number]>,
): Promise<void> => {
  const mapPath = `${bundlePath}.map`;
  if (!existsSync(mapPath)) {
    console.warn(`  skip: no sourcemap at ${mapPath}`);
    return;
  }
  const map = JSON.parse(await readFile(mapPath, "utf8")) as SourceMap;
  const mapDir = dirname(mapPath);
  const lineMap = parseMappings(map);
  for (const [genLine, hits] of daEntries) {
    const entry = lineMap.get(genLine);
    if (!entry) continue;
    // Sourcemap `sources` are relative to the sourcemap file. Resolve to abs.
    const sourceAbs = resolve(mapDir, entry.source);
    // Skip mappings that resolve OUTSIDE the repo (Bun sometimes emits
    // node_modules references in mappings; we don't track coverage on those).
    if (!sourceAbs.startsWith(REPO_ROOT + "/src/")) continue;
    recordLineHit(sourceAbs, entry.sourceLine, hits);
  }
};

const main = async () => {
  if (!existsSync(LCOV_PATH)) {
    console.error(`lcov not found at ${LCOV_PATH}`);
    process.exit(1);
  }
  await copyFile(LCOV_PATH, `${LCOV_PATH}.pre-remap`);

  const text = await readFile(LCOV_PATH, "utf8");
  const recordLines = text.split("\n");

  // Walk lcov records: each starts with SF:, ends with end_of_record.
  let currentSF: string | null = null;
  let currentDA: Array<[number, number]> = [];
  let currentFnLines: string[] = [];
  let currentFNF = 0;
  let currentFNH = 0;

  const finishRecord = async () => {
    if (!currentSF) return;
    if (currentSF.startsWith(".test-bundles/")) {
      // Bundle record — remap line hits via sourcemap. FN totals from
      // the bundle are NOT remapped (bun's lcov has FNF/FNH totals but
      // no per-function line info we can map back).
      const abs = resolve(REPO_ROOT, currentSF);
      await remapBundleRecord(abs, currentDA);
    } else {
      // Plain source record — preserve verbatim into the same source's
      // aggregate. Line hits stack with anything the bundle contributed
      // for the same lines (max wins).
      const sourceAbs = currentSF.startsWith("/")
        ? currentSF
        : resolve(REPO_ROOT, currentSF);
      const cov = getSource(sourceAbs);
      for (const [line, hits] of currentDA) recordLineHit(sourceAbs, line, hits);
      cov.fnEntries.push(...currentFnLines);
      cov.fnf += currentFNF;
      cov.fnh += currentFNH;
    }
    currentSF = null;
    currentDA = [];
    currentFnLines = [];
    currentFNF = 0;
    currentFNH = 0;
  };

  for (const line of recordLines) {
    if (line.startsWith("SF:")) {
      await finishRecord();
      currentSF = line.slice(3);
    } else if (line === "end_of_record") {
      await finishRecord();
    } else if (line.startsWith("DA:")) {
      const [g, h] = line.slice(3).split(",").map(Number);
      if (Number.isFinite(g) && Number.isFinite(h)) currentDA.push([g, h]);
    } else if (line.startsWith("FN:") || line.startsWith("FNDA:")) {
      currentFnLines.push(line);
    } else if (line.startsWith("FNF:")) {
      currentFNF = Number(line.slice(4)) || 0;
    } else if (line.startsWith("FNH:")) {
      currentFNH = Number(line.slice(4)) || 0;
    }
  }
  await finishRecord();

  // Emit one record per source.
  const out: string[] = ["TN:"];
  let totalLF = 0;
  let totalLH = 0;
  for (const [sourceAbs, cov] of sources) {
    out.push(`SF:${sourceAbs}`);
    if (cov.fnEntries.length > 0) out.push(...cov.fnEntries);
    if (cov.fnf > 0 || cov.fnh > 0) {
      out.push(`FNF:${cov.fnf}`, `FNH:${cov.fnh}`);
    }
    const sortedLines = [...cov.lines.entries()].sort((a, b) => a[0] - b[0]);
    let lf = 0;
    let lh = 0;
    for (const [line, hits] of sortedLines) {
      out.push(`DA:${line},${hits}`);
      lf++;
      if (hits > 0) lh++;
    }
    out.push(`LF:${lf}`, `LH:${lh}`, "end_of_record");
    totalLF += lf;
    totalLH += lh;
  }

  await writeFile(LCOV_PATH, out.join("\n") + "\n");

  const pct = totalLF > 0 ? ((totalLH / totalLF) * 100).toFixed(2) : "0";
  console.log(
    `remap: ${sources.size} source files, ${totalLH}/${totalLF} lines hit (${pct}%)`,
  );
};

main().catch((e) => {
  console.error("remap-coverage crashed:", e);
  process.exit(2);
});
