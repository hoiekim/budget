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
const STUB_HELPERS = ["stubFetch"];
const TEARDOWN = ["afterAll", "afterEach"];

const testFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return SKIP_DIR.test(entry) ? [] : testFiles(full);
    return TEST_FILE.test(entry) ? [full] : [];
  });

const parseSource = (fileName: string, text: string): ts.SourceFile =>
  ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

const parse = (file: string): ts.SourceFile => parseSource(file, readFileSync(file, "utf8"));

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

/** `globalThis.fetch = …` / `global.fetch = …`. */
const assignsFetch = (node: ts.Node, source: ts.SourceFile): boolean =>
  ts.isBinaryExpression(node) &&
  node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
  ts.isPropertyAccessExpression(node.left) &&
  node.left.name.text === "fetch" &&
  ["globalThis", "global"].includes(node.left.expression.getText(source));

/**
 * A call to a helper that installs the stub on the file's behalf. Such a file
 * names neither `globalThis` nor `fetch` anywhere, so the assignment predicate
 * cannot see it — and the helper is the easiest stub site to reach, which would
 * leave the invariant enforced everywhere except where it is most used.
 */
const callsStubHelper = (node: ts.Node, source: ts.SourceFile): boolean =>
  ts.isCallExpression(node) && STUB_HELPERS.includes(node.expression.getText(source));

/** Anything that leaves a stub installed past the statement that made it. */
const stubsFetch = (source: ts.SourceFile): boolean =>
  some(source, (node) => assignsFetch(node, source) || callsStubHelper(node, source));

/**
 * A snapshot restorer, or the `restore` handle a stub helper hands back — the
 * helper's own body is what reaches the snapshot in that case.
 */
const isRestorer = (node: ts.Node): boolean =>
  (ts.isIdentifier(node) && RESTORERS.includes(node.text)) ||
  (ts.isPropertyAccessExpression(node) && node.name.text === "restore");

/** A teardown hook whose callback reaches a restorer. */
const restoresFetch = (source: ts.SourceFile): boolean =>
  some(
    source,
    (node) =>
      ts.isCallExpression(node) &&
      TEARDOWN.includes(node.expression.getText(source)) &&
      node.arguments.some((argument) => some(argument, isRestorer)),
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

  test("the scan sees a stub installed through a helper, and its restore", () => {
    const offends = (body: string): boolean => {
      const source = parseSource("fixture.test.tsx", body);
      return stubsFetch(source) && !restoresFetch(source);
    };

    expect(offends(`let s: unknown;\nit("x", () => { s = stubFetch([]); });`)).toBe(true);
    expect(
      offends(
        `let s: { restore: () => void } | undefined;\n` +
          `afterEach(() => { s?.restore(); });\n` +
          `it("x", () => { s = stubFetch([]); });`,
      ),
    ).toBe(false);
  });

  test("restoreLeaves covers fetch alongside the module leaves", () => {
    const stub = (async () => new Response("")) as unknown as typeof fetch;
    globalThis.fetch = stub;

    restoreLeaves();

    expect(globalThis.fetch).toBe((globalThis as { __REAL_FETCH: typeof fetch }).__REAL_FETCH);
  });
});
