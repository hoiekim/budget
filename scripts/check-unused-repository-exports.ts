#!/usr/bin/env bun
/**
 * Unused repository-export check (issue #862).
 *
 * Walks `src/server/lib/postgres/repositories/*.ts`, collects every
 * `export const` name, and fails on any name with no reference outside its
 * own file. The barrel (`repositories/index.ts`) re-exports everything, so
 * its lines do not count as references.
 *
 * The test is deliberately "zero references outside the defining file":
 * it flags both the truly-dead exports (zero callers anywhere) and the
 * over-exported ones (used only inside their own file, where the `export`
 * keyword is what is dead rather than the function). Both classes need an
 * edit — delete the function, or drop the `export`.
 *
 * Usage: bun scripts/check-unused-repository-exports.ts
 */

import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";

const REPOSITORIES_DIR = "src/server/lib/postgres/repositories";
const SRC_DIR = "src";
const BARREL = path.join(REPOSITORIES_DIR, "index.ts");

/** Every file under `dir`, recursively. */
const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return [full];
  });

const repositoryFiles = sourceFiles(REPOSITORIES_DIR).filter(
  (file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== BARREL,
);

const srcFiles = sourceFiles(SRC_DIR).filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"));
const srcTexts = new Map(srcFiles.map((file) => [file, readFileSync(file, "utf8")]));

const unused: { file: string; name: string }[] = [];

for (const file of repositoryFiles) {
  const text = srcTexts.get(file) ?? "";
  for (const match of text.matchAll(/^export const ([A-Za-z0-9_]+)/gm)) {
    const name = match[1];
    const pattern = new RegExp(`\\b${name}\\b`);
    const referencedOutside = srcFiles.some(
      (other) => other !== file && other !== BARREL && pattern.test(srcTexts.get(other) ?? ""),
    );
    if (!referencedOutside) unused.push({ file, name });
  }
}

if (unused.length > 0) {
  for (const { file, name } of unused) {
    console.error(`unused export: ${file} :: ${name}`);
  }
  console.error(
    `${unused.length} unused repository export(s): delete the function, or drop the \`export\` if it is only used inside its own file.`,
  );
  process.exit(1);
}

console.log("No unused repository exports.");
