import { describe, it, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import ts from "typescript";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

/**
 * The two directions ask different questions, so they scan different trees.
 *
 * "Is every read documented?" is about the knobs an operator supplies to the
 * running server, so it scans `src/` plus the healthcheck the runtime image
 * runs as its HEALTHCHECK command. A one-off script's own env surface, and the
 * host's build config, have no business in a deployment's env file.
 *
 * "Is this entry dead?" is about whether anything at all reads the name, so it
 * spans every tree that ships or runs, root files included.
 *
 * Both name their root files rather than scanning the repo root. A directory
 * root's contents are not declared, so the missing-root throw below cannot see
 * them, and the verdict would then differ between this host and the Docker
 * builder, which copies only the root files the `Dockerfile` names.
 */
const SERVER_ROOTS = ["src", "healthcheck.js"];
const ALL_ROOTS = ["src", "scripts", "vite.config.ts", "eslint.config.js", "healthcheck.js"];

const SOURCE_FILE = /\.(?:[mc]?[jt]sx?)$/;
const TEST_FILE = /\.test\.[mc]?[jt]sx?$/;
const SKIP_DIR = /^(?:node_modules|build|dist|coverage|\.git)$/;

/**
 * Names that reach their reader by a route no static extraction can follow,
 * each with the reason. Declaring a name here is the only way it is exempted.
 */
const INDIRECTLY_READ: Record<string, string> = {};

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      return SKIP_DIR.test(entry) ? [] : sourceFiles(full);
    }
    if (!SOURCE_FILE.test(entry) || TEST_FILE.test(entry)) return [];
    return [full];
  });

const filesUnder = (roots: string[]): string[] =>
  roots.flatMap((root) => {
    const full = path.join(REPO_ROOT, root);
    if (!existsSync(full)) throw new Error(`scan root is missing: ${root}`);
    if (!statSync(full).isDirectory()) return [full];
    return sourceFiles(full);
  });

const SCRIPT_KIND: Record<string, ts.ScriptKind> = {
  ".ts": ts.ScriptKind.TS,
  ".mts": ts.ScriptKind.TS,
  ".cts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".js": ts.ScriptKind.JS,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
};

/**
 * `process.env` / `Bun.env`, in optional-chained form too.
 *
 * The client's `import.meta.env` is out of scope: Vite's own built-ins live
 * there alongside `VITE_*`, so it is a separate surface with a separate
 * contract, not an entry this template is expected to carry.
 */
const isEnvObject = (node: ts.Node): boolean =>
  ts.isPropertyAccessExpression(node) &&
  node.name.text === "env" &&
  ts.isIdentifier(node.expression) &&
  (node.expression.text === "process" || node.expression.text === "Bun");

/** `??=`, `||=`, `&&=` — an assignment whose whole point is to read first. */
const LOGICAL_ASSIGNMENT = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
]);

/**
 * A variable the server assigns to itself is not a surface an operator
 * supplies. Logical assignment is the exception: `process.env.X ??= "default"`
 * exists to defer to whatever the operator supplied, so `X` stays a read.
 *
 * The arithmetic compounds and `++` / `--` read their left side too, and are
 * still classified as writes: they derive a value from one the process already
 * held rather than accept one. None is live here, but a `PATH`-shaped
 * `process.env.X += ":/opt"` would be an operator surface this misses.
 */
const isWriteTarget = (access: ts.Node): boolean => {
  const parent = access.parent;
  if (ts.isDeleteExpression(parent)) return true;
  if (ts.isPostfixUnaryExpression(parent)) return true;
  if (ts.isPrefixUnaryExpression(parent)) {
    return (
      parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken
    );
  }
  if (ts.isBinaryExpression(parent) && parent.left === access) {
    const { kind } = parent.operatorToken;
    if (LOGICAL_ASSIGNMENT.has(kind)) return false;
    return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
  }
  return false;
};

interface Extraction {
  /** Variable names this file reads off the env object. */
  read: string[];
  /** Sites that hand the env object somewhere the parser cannot follow. */
  opaque: string[];
}

/**
 * Every read of the env object in one file, taken off the parsed syntax tree.
 *
 * Working from the tree rather than the text is what makes a name in a comment,
 * a log string or a JSX text node impossible to mistake for a read. An access
 * that reaches the env object under no statically known name — a spread, a
 * computed key, an alias — is reported as opaque rather than dropped.
 */
const extract = (file: string): Extraction => {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    SCRIPT_KIND[path.extname(file)] ?? ts.ScriptKind.TS
  );

  const read: string[] = [];
  const opaque: string[] = [];

  const site = (node: ts.Node, reason: string) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    opaque.push(`${path.relative(REPO_ROOT, file)}:${line + 1}: ${reason}`);
  };

  const visit = (node: ts.Node) => {
    if (isEnvObject(node)) {
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        if (!isWriteTarget(parent)) read.push(parent.name.text);
      } else if (ts.isElementAccessExpression(parent) && parent.expression === node) {
        const key = parent.argumentExpression;
        if (ts.isStringLiteralLike(key)) {
          if (!isWriteTarget(parent)) read.push(key.text);
        } else {
          site(parent, "computed key");
        }
      } else if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
        if (ts.isObjectBindingPattern(parent.name)) {
          for (const element of parent.name.elements) {
            const key = element.propertyName ?? element.name;
            if (element.dotDotDotToken) site(element, "rest binding");
            else if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) read.push(key.text);
            else site(element, "computed binding");
          }
        } else {
          site(parent, `bound to ${parent.name.getText(source)}`);
        }
      } else {
        site(node, `reached as ${ts.SyntaxKind[parent.kind]}`);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return { read, opaque };
};

/**
 * Files whose reads SNAPSHOT a variable rather than consume it.
 *
 * The test preload records the market-data env so `restoreEnv` can put it back
 * between test files. That is a read of the name and no evidence that anything
 * still uses the variable, so counting it would keep an entry documented
 * forever after its last real consumer was deleted. Its accesses still count
 * for the opaque direction, which is about whether a name can be resolved at
 * all.
 */
const SNAPSHOT_ONLY = ["scripts/test-preload.ts"];

const collect = (roots: string[]) => {
  const read = new Set<string>();
  const opaque: string[] = [];
  for (const file of filesUnder(roots)) {
    const extraction = extract(file);
    const relative = path.relative(REPO_ROOT, file);
    if (!SNAPSHOT_ONLY.includes(relative)) {
      for (const name of extraction.read) {
        if (/^[A-Z_][A-Z0-9_]*$/.test(name)) read.add(name);
      }
    }
    opaque.push(...extraction.opaque);
  }
  return { read, opaque };
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

  /**
   * No exemption list, unlike the dead direction: an unfollowable env access is
   * a gap in what the other two assertions can see, so it is fixed at the call
   * site rather than declared. `{ ...process.env }` stays available in tests,
   * which this scan excludes.
   */
  it("has no env access whose variable name it cannot resolve", () => {
    expect(collect(ALL_ROOTS).opaque).toEqual([]);
  });
});
