import { describe, it, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import path from "path";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

/**
 * The two directions ask different questions, so they scan different trees.
 *
 * "Is every read documented?" is about the knobs an operator supplies to the
 * running server, so it scans `src/`. A one-off script's own env surface has no
 * business in a deployment's env file.
 *
 * "Is this entry dead?" is about whether anything at all reads the name, so it
 * spans every tree that ships or runs — including files at the repo root, which
 * is where the container healthcheck lives.
 */
const SERVER_ROOTS = ["src"];
const ALL_ROOTS = ["src", "scripts", "."];

const SOURCE_FILE = /\.(?:[mc]?[jt]sx?)$/;
const TEST_FILE = /\.test\.[mc]?[jt]sx?$/;
const SKIP_DIR = /^(?:node_modules|build|dist|coverage|\.git)$/;

/**
 * Names that reach their reader by a route no static extraction can follow,
 * each with the reason. An entry is a claim someone checked, and the only way
 * a name is exempted — there is no path by which a variable absolves itself.
 */
const INDIRECTLY_READ: Record<string, string> = {};

const sourceFiles = (dir: string, recurse: boolean): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      return recurse && !SKIP_DIR.test(entry) ? sourceFiles(full, true) : [];
    }
    if (!SOURCE_FILE.test(entry) || TEST_FILE.test(entry)) return [];
    return [full];
  });

const filesUnder = (roots: string[]): string[] =>
  roots.flatMap((root) => {
    const dir = path.join(REPO_ROOT, root);
    if (!existsSync(dir)) return [];
    return sourceFiles(dir, root !== ".");
  });

const ENV_OBJECT = /(?:process|Bun)\.env\s*(?:\?\.)?\[\s*$/;
const ASSIGNMENT = /^\s*(?:\?\?|\|\||&&|\+|-|\*|\/|%|\*\*)?=(?!=)/;

interface Scanned {
  /** Comment bodies and string contents blanked to spaces. Text that merely
   *  looks like a read is not one, and brace depth stays balanced. */
  code: string;
  /** `env["NAME"]` names, collected before blanking hides them. */
  bracketReads: string[];
}

const scan = (source: string): Scanned => {
  const out = source.split("");
  const bracketReads: string[] = [];
  let i = 0;

  const blank = (from: number, to: number) => {
    for (let j = from; j < to; j++) if (out[j] !== "\n") out[j] = " ";
  };

  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      const end = source.indexOf("\n", i);
      blank(i, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end;
    } else if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (source[i] === '"' || source[i] === "'" || source[i] === "`") {
      const quote = source[i];
      let j = i + 1;
      while (j < source.length && source[j] !== quote) {
        if (source[j] === "\\") j += 1;
        j += 1;
      }
      const body = source.slice(i + 1, j);
      if (ENV_OBJECT.test(source.slice(0, i)) && !body.includes("\\")) {
        const close = source.indexOf("]", j);
        const isDelete = /delete\s+(?:process|Bun)\.env\s*(?:\?\.)?\[\s*$/.test(
          source.slice(0, i)
        );
        if (close !== -1 && !isDelete && !ASSIGNMENT.test(source.slice(close + 1))) {
          bracketReads.push(body);
        }
      }
      blank(i + 1, j);
      i = j + 1;
    } else {
      i += 1;
    }
  }

  return { code: out.join(""), bracketReads };
};

const DOT_READ = /(delete\s+)?(?:process|Bun)\.env\s*(?:\?\.|\.)\s*([A-Za-z_$][A-Za-z0-9_$]*)/g;

/**
  * `env.NAME` on the right-hand side. A variable the server assigns to itself is
  * not a surface an operator supplies, so writes are excluded whatever their
  * operator. The name is one whole-identifier capture and the assignment test
  * runs outside the pattern, so no name can be reported as a partial match.
  */
const dotReads = (code: string): string[] => {
  const names: string[] = [];
  for (const match of code.matchAll(DOT_READ)) {
    if (match[1]) continue;
    if (ASSIGNMENT.test(code.slice(match.index + match[0].length))) continue;
    names.push(match[2]);
  }
  return names;
};

/** `const { A, B = "fallback" } = env`, single- or multi-line. */
const destructuredReads = (code: string): string[] => {
  const names: string[] = [];
  for (const match of code.matchAll(/\}\s*=\s*(?:process|Bun)\.env\b/g)) {
    const close = code.indexOf("}", match.index);
    let depth = 0;
    let open = -1;
    for (let i = close; i >= 0; i--) {
      if (code[i] === "}") depth += 1;
      else if (code[i] === "{") {
        depth -= 1;
        if (depth === 0) {
          open = i;
          break;
        }
      }
    }
    if (open === -1) continue;
    for (const part of code.slice(open + 1, close).split(",")) {
      names.push(part.split(/[=:]/)[0].trim());
    }
  }
  return names;
};

/**
 * `const env = process.env` hands the object to a name this file cannot follow.
 * Reporting it is the only honest option: skipping it would let an undocumented
 * read through, and guessing at the alias's members would invent evidence.
 */
const aliases = (code: string): string[] =>
  [...code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:process|Bun)\.env\s*(?![.?[\w$])/g)]
    .map((match) => match[1]);

const collect = (roots: string[]) => {
  const read = new Set<string>();
  const aliased: string[] = [];
  for (const file of filesUnder(roots)) {
    const { code, bracketReads } = scan(readFileSync(file, "utf8"));
    for (const name of [...dotReads(code), ...destructuredReads(code), ...bracketReads]) {
      if (/^[A-Z_][A-Z0-9_]*$/.test(name)) read.add(name);
    }
    for (const alias of aliases(code)) {
      aliased.push(`${path.relative(REPO_ROOT, file)}: ${alias}`);
    }
  }
  return { read, aliased };
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
    const undocumented = [...collect(SERVER_ROOTS).read]
      .filter((name) => !documented.has(name))
      .sort();
    expect(undocumented).toEqual([]);
  });

  it("documents no variable that is never read", () => {
    const { read } = collect(ALL_ROOTS);
    const dead = [...documentedVariables()]
      .filter((name) => !read.has(name) && !(name in INDIRECTLY_READ))
      .sort();
    expect(dead).toEqual([]);
  });

  it("has no env alias it cannot follow", () => {
    expect(collect(ALL_ROOTS).aliased).toEqual([]);
  });
});
