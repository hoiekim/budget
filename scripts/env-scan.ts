import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import ts from "typescript";

/**
 * One scanner for every question about which env names the tree reads.
 *
 * Two tests ask that question — `.env.example` asks whether an entry is
 * documented and whether it is dead, and the test harness asks whether the
 * market-data snapshot covers what the product reads. They share this
 * extractor rather than each carrying a parser, because a second parser is a
 * second set of shapes to miss, and a reader-shape it misses makes the guard
 * built on it pass silently.
 */
export const REPO_ROOT = path.resolve(import.meta.dir, "..");

export const SOURCE_FILE = /\.(?:[mc]?[jt]sx?)$/;
export const TEST_FILE = /\.test\.[mc]?[jt]sx?$/;
export const SKIP_DIR = /^(?:node_modules|build|dist|coverage|\.git)$/;

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

export const filesUnder = (roots: string[]): string[] =>
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
export const extract = (file: string): Extraction => {
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


export const envReads = (roots: string[]): { read: Set<string>; opaque: string[] } => {
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
