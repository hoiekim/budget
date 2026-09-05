import { describe, it, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import ts from "typescript";

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
 * each with the reason. Declaring a name here is the only way it is exempted.
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

/** `process.env` / `Bun.env`, in optional-chained form too. */
const isEnvObject = (node: ts.Node): boolean =>
  ts.isPropertyAccessExpression(node) &&
  node.name.text === "env" &&
  ts.isIdentifier(node.expression) &&
  (node.expression.text === "process" || node.expression.text === "Bun");

/**
 * A variable the server assigns to itself is not a surface an operator
 * supplies, so writes are excluded whatever their operator.
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

const collect = (roots: string[]) => {
  const read = new Set<string>();
  const opaque: string[] = [];
  for (const file of filesUnder(roots)) {
    const extraction = extract(file);
    for (const name of extraction.read) {
      if (/^[A-Z_][A-Z0-9_]*$/.test(name)) read.add(name);
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

  it("has no env access whose variable name it cannot resolve", () => {
    expect(collect(ALL_ROOTS).opaque).toEqual([]);
  });
});
