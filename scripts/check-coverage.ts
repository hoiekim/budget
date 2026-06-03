#!/usr/bin/env bun
/**
 * Coverage threshold enforcement.
 *
 * Reads coverage/lcov.info and fails if overall line or function coverage
 * drops below the configured thresholds.
 *
 * Usage: bun scripts/check-coverage.ts
 *
 * Thresholds are intentionally conservative — ratchet them up as test coverage
 * improves. The goal is to prevent regressions, not to demand 100% overnight.
 */

const THRESHOLDS = {
  lines: 28,     // % — ratchet up as coverage improves (currently ~28.7%)
  functions: 48, // % — ratchet up as coverage improves (currently ~48.9%)
};

const LCOV_PATH = "coverage/lcov.info";

/**
 * Source-file prefixes to EXCLUDE from coverage. Limits the measure to
 * `src/` only so test-side scaffolding doesn't drag the percentage.
 */
const EXCLUDED_SF_PREFIXES = ["scripts/"];

async function parseLcov(path: string): Promise<{ linesFound: number; linesHit: number; functionsFound: number; functionsHit: number }> {
  const text = await Bun.file(path).text();
  let linesFound = 0, linesHit = 0, functionsFound = 0, functionsHit = 0;

  // lcov is record-per-file: each record opens with `SF:<path>` and
  // ends at `end_of_record`. Skip excluded records wholesale.
  let skipRecord = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      const sf = line.slice(3);
      skipRecord = EXCLUDED_SF_PREFIXES.some((p) => sf.startsWith(p));
      continue;
    }
    if (line === "end_of_record") {
      skipRecord = false;
      continue;
    }
    if (skipRecord) continue;
    if (line.startsWith("LF:")) linesFound += parseInt(line.slice(3), 10);
    else if (line.startsWith("LH:")) linesHit += parseInt(line.slice(3), 10);
    else if (line.startsWith("FNF:")) functionsFound += parseInt(line.slice(4), 10);
    else if (line.startsWith("FNH:")) functionsHit += parseInt(line.slice(4), 10);
  }

  return { linesFound, linesHit, functionsFound, functionsHit };
}

const stats = await parseLcov(LCOV_PATH);
const linePct = stats.linesFound > 0 ? (stats.linesHit / stats.linesFound) * 100 : 0;
const fnPct = stats.functionsFound > 0 ? (stats.functionsHit / stats.functionsFound) * 100 : 0;

console.log(`\nCoverage summary:`);
console.log(`  Lines:     ${linePct.toFixed(2)}% (${stats.linesHit}/${stats.linesFound}) — threshold: ${THRESHOLDS.lines}%`);
console.log(`  Functions: ${fnPct.toFixed(2)}% (${stats.functionsHit}/${stats.functionsFound}) — threshold: ${THRESHOLDS.functions}%`);

let failed = false;

if (linePct < THRESHOLDS.lines) {
  console.error(`\n❌ Line coverage ${linePct.toFixed(2)}% is below threshold ${THRESHOLDS.lines}%`);
  failed = true;
}

if (fnPct < THRESHOLDS.functions) {
  console.error(`\n❌ Function coverage ${fnPct.toFixed(2)}% is below threshold ${THRESHOLDS.functions}%`);
  failed = true;
}

if (!failed) {
  console.log(`\n✅ Coverage thresholds passed`);
  process.exit(0);
} else {
  process.exit(1);
}
