import { describe, test, expect, afterAll } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import ts from "typescript";
import { restoreFetch, restoreLeaves } from "test-helpers";

/**
 * `globalThis.fetch` carries bun's `mock.module` hazard without its
 * bookkeeping: process-global, no unmock API, and nothing that puts it back
 * between files. Two rules keep it contained, and each needs its own kind of
 * check.
 *
 * The restore has to come from the preload's snapshot. A file that saves the
 * value it found on the way in saves whatever the previous file left, so one
 * leak survives every polite restore after it.
 *
 * And the rule has to hold for a file written later. No runtime hook can see
 * another file's teardown — bun's preloaded `afterAll` fires once per run, not
 * once per file — while the symptom is a 5-second timeout dozens of files
 * downstream, pointing at the wrong one. So the second check reads the sources.
 */

const SRC = path.join(import.meta.dir, "../..");
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const SKIP_DIR = /^(?:node_modules|build|dist|coverage)$/;
const RESTORERS = ["restoreFetch", "restoreLeaves"];
const TEARDOWN = ["afterAll", "afterEach"];

const testFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return SKIP_DIR.test(entry) ? [] : testFiles(full);
    return TEST_FILE.test(entry) ? [full] : [];
  });

const parse = (file: string): ts.SourceFile =>
  ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

const some = (root: ts.Node, predicate: (node: ts.Node) => boolean): boolean => {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (predicate(node)) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
};

/** `globalThis.fetch = …` / `global.fetch = …`, anywhere in the file. */
const stubsFetch = (source: ts.SourceFile): boolean =>
  some(
    source,
    (node) =>
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === "fetch" &&
      ["globalThis", "global"].includes(node.left.expression.getText(source)),
  );

/** A teardown hook whose callback reaches one of the snapshot restorers. */
const restoresFetch = (source: ts.SourceFile): boolean =>
  some(
    source,
    (node) =>
      ts.isCallExpression(node) &&
      TEARDOWN.includes(node.expression.getText(source)) &&
      node.arguments.some((argument) =>
        some(argument, (inner) => ts.isIdentifier(inner) && RESTORERS.includes(inner.text)),
      ),
  );

describe("globalThis.fetch stubs", () => {
  afterAll(restoreFetch);

  test("every test file that stubs it restores it in a teardown hook", () => {
    const offenders = testFiles(SRC)
      .filter((file) => {
        const source = parse(file);
        return stubsFetch(source) && !restoresFetch(source);
      })
      .map((file) => path.relative(SRC, file));

    expect(offenders).toEqual([]);
  });

  test("restoreFetch installs the preload's snapshot, not the inherited value", () => {
    const stub = (async () => new Response("")) as unknown as typeof fetch;
    globalThis.fetch = stub;

    restoreFetch();

    expect(globalThis.fetch).toBe((globalThis as { __REAL_FETCH: typeof fetch }).__REAL_FETCH);
  });

  test("restoreLeaves covers fetch alongside the module leaves", () => {
    const stub = (async () => new Response("")) as unknown as typeof fetch;
    globalThis.fetch = stub;

    restoreLeaves();

    expect(globalThis.fetch).toBe((globalThis as { __REAL_FETCH: typeof fetch }).__REAL_FETCH);
  });
});
