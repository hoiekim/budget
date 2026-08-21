import { describe, it, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import path from "path";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
/**
 * The two directions ask different questions, so they scan different trees.
 *
 * "Is every read documented?" is about the knobs an operator supplies to the
 * running server, which is `src/`. A one-off migration script under `scripts/`
 * has its own env surface that has no business in the deployment's env file.
 *
 * "Is this entry dead?" is about whether anything reads the name at all, so it
 * spans both — otherwise the guard would recommend deleting an entry a script
 * still depends on.
 */
const SERVER_ROOTS = [path.join(REPO_ROOT, "src")];
const ALL_ROOTS = [path.join(REPO_ROOT, "src"), path.join(REPO_ROOT, "scripts")];

/**
 * Names no static extraction can attribute to a read, each with the reason it
 * is nonetheless live. An entry is a claim someone checked, which is the point:
 * a variable whose only appearance is inside a log string or a comment would
 * otherwise absolve itself, and that is exactly how a dead entry survives.
 */
const INDIRECTLY_READ: Record<string, string> = {};

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) return [];
    return [full];
  });

const ASSIGNMENT = /^\s*(?:\?\?|\|\||&&|\+|-|\*|\/|%|\*\*)?=(?!=)/;

/**
 * `process.env.NAME`, `process.env["NAME"]` and their `?.` forms. The name is
 * captured by a whole-identifier class with no lookahead inside it, so the
 * match cannot backtrack into a truncated prefix when the text that follows is
 * rejected — a phantom name would fail this suite on a variable that does not
 * exist.
 *
 * Writes are excluded, whatever their operator: a variable the server assigns
 * to itself is not a surface an operator supplies.
 */
const ENV_ACCESS =
  /(delete\s+)?process\.env\s*(?:\?\.|\.)\s*([A-Za-z_$][A-Za-z0-9_$]*)|(delete\s+)?process\.env\s*(?:\?\.)?\[\s*["']([^"']*)["']\s*\]/g;

const directReads = (source: string): string[] => {
  const names: string[] = [];
  for (const match of source.matchAll(ENV_ACCESS)) {
    if (match[1] || match[3]) continue;
    const name = match[2] ?? match[4];
    if (!name) continue;
    if (ASSIGNMENT.test(source.slice(match.index + match[0].length))) continue;
    names.push(name);
  }
  return names;
};

/**
 * `const { A, B = "fallback" } = process.env`, single- or multi-line. Scans
 * backwards from the matching brace rather than matching `[^{}]*`, so a default
 * value that itself contains braces does not silently yield nothing — an
 * under-captured read reads as an undocumented variable one direction and as a
 * dead entry the other.
 */
const destructuredReads = (source: string): string[] => {
  const names: string[] = [];
  for (const match of source.matchAll(/\}\s*=\s*process\.env\b/g)) {
    const close = source.indexOf("}", match.index);
    let depth = 0;
    let open = -1;
    for (let i = close; i >= 0; i--) {
      if (source[i] === "}") depth += 1;
      else if (source[i] === "{") {
        depth -= 1;
        if (depth === 0) {
          open = i;
          break;
        }
      }
    }
    if (open === -1) continue;
    for (const part of source.slice(open + 1, close).split(",")) {
      const name = part.split(/[=:]/)[0].trim();
      if (/^[A-Z_][A-Z0-9_]*$/.test(name)) names.push(name);
    }
  }
  return names;
};

const readVariables = (roots: string[]): Set<string> => {
  const names = new Set<string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, "utf8");
      for (const name of directReads(source)) names.add(name);
      for (const name of destructuredReads(source)) names.add(name);
    }
  }
  return names;
};

const documentedVariables = (): Set<string> =>
  new Set(
    [
      ...readFileSync(path.join(REPO_ROOT, ".env.example"), "utf8").matchAll(
        /^#?\s*([A-Z_][A-Z0-9_]*)=/gm
      ),
    ].map((match) => match[1])
  );

describe(".env.example", () => {
  it("documents every variable the server reads", () => {
    const documented = documentedVariables();
    const undocumented = [...readVariables(SERVER_ROOTS)]
      .filter((name) => /^[A-Z_][A-Z0-9_]*$/.test(name))
      .filter((name) => !documented.has(name))
      .sort();
    expect(undocumented).toEqual([]);
  });

  it("documents no variable that is never read", () => {
    const read = readVariables(ALL_ROOTS);
    const dead = [...documentedVariables()]
      .filter((name) => !read.has(name) && !(name in INDIRECTLY_READ))
      .sort();
    expect(dead).toEqual([]);
  });
});
