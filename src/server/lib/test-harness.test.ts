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
 * The names a stub helper answers to in this file. An import may rename it, and
 * a call through the alias installs the same stub, so matching the exported
 * name alone would leave that spelling invisible.
 */
const stubHelperNames = (source: ts.SourceFile): string[] => {
  const names = [...STUB_HELPERS];
  source.forEachChild((node) => {
    const bindings = ts.isImportDeclaration(node) && node.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return;
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text || element.name.text;
      if (STUB_HELPERS.includes(imported)) names.push(element.name.text);
    }
  });
  return names;
};

/**
 * A call to a helper that installs the stub on the file's behalf. Such a file
 * names neither `globalThis` nor `fetch` anywhere, so the assignment predicate
 * cannot see it — and the helper is the easiest stub site to reach, which would
 * leave the invariant enforced everywhere except where it is most used.
 */
const callsStubHelper = (node: ts.Node, helpers: string[]): boolean =>
  ts.isCallExpression(node) &&
  ts.isIdentifier(node.expression) &&
  helpers.includes(node.expression.text);

/** Anything that leaves a stub installed past the statement that made it. */
const stubsFetch = (source: ts.SourceFile, helpers: string[]): boolean =>
  some(source, (node) => assignsFetch(node, source) || callsStubHelper(node, helpers));

/** The identifiers this file assigns a stub helper's return value to. */
const stubHandles = (source: ts.SourceFile, helpers: string[]): string[] => {
  const names: string[] = [];
  const visit = (node: ts.Node) => {
    const target =
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      callsStubHelper(node.right, helpers)
        ? node.left
        : ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.initializer &&
            callsStubHelper(node.initializer, helpers)
          ? node.name
          : undefined;
    if (target) names.push(target.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
};

/**
 * A snapshot restorer, or the `restore` handle a stub helper hands back — the
 * helper's own body is what reaches the snapshot in that case. The receiver has
 * to be a handle this file took from such a call: `mock.restore()` is bun's own
 * idiom for resetting module mocks, reads as the right thing to write next to a
 * stub, and leaves `globalThis.fetch` exactly where it was.
 */
const isRestorer =
  (handles: string[]) =>
  (node: ts.Node): boolean =>
    (ts.isIdentifier(node) && RESTORERS.includes(node.text)) ||
    (ts.isPropertyAccessExpression(node) &&
      node.name.text === "restore" &&
      ts.isIdentifier(node.expression) &&
      handles.includes(node.expression.text));

/** A teardown hook whose callback reaches a restorer. */
const restoresFetch = (source: ts.SourceFile, handles: string[]): boolean =>
  some(
    source,
    (node) =>
      ts.isCallExpression(node) &&
      TEARDOWN.includes(node.expression.getText(source)) &&
      node.arguments.some((argument) => some(argument, isRestorer(handles))),
  );

/** A file that installs a stub and leaves it installed for the next one. */
const leaksFetch = (source: ts.SourceFile): boolean => {
  const helpers = stubHelperNames(source);
  return stubsFetch(source, helpers) && !restoresFetch(source, stubHandles(source, helpers));
};

const offends = (body: string): boolean => leaksFetch(parseSource("fixture.test.tsx", body));

describe("globalThis.fetch stubs", () => {
  afterAll(restoreFetch);

  test("every test file that stubs it restores it in a teardown hook", () => {
    const offenders = testFiles(SRC)
      .filter((file) => leaksFetch(parse(file)))
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
    expect(offends(`let s: unknown;\nit("x", () => { s = stubFetch([]); });`)).toBe(true);
    expect(
      offends(
        `let s: { restore: () => void } | undefined;\n` +
          `afterEach(() => { s?.restore(); });\n` +
          `it("x", () => { s = stubFetch([]); });`,
      ),
    ).toBe(false);
  });

  test("the scan follows a helper imported under another name", () => {
    const stub = `import { stubFetch as installStub } from "test-render";\n`;

    expect(offends(`${stub}let s: unknown;\nit("x", () => { s = installStub([]); });`)).toBe(true);
    expect(
      offends(
        stub +
          `let s: { restore: () => void } | undefined;\n` +
          `afterEach(() => { s?.restore(); });\n` +
          `it("x", () => { s = installStub([]); });`,
      ),
    ).toBe(false);
  });

  test("a teardown that only resets module mocks does not count as a restore", () => {
    const assign = `it("x", () => { globalThis.fetch = (async () => new Response("")) as never; });`;

    expect(offends(`afterEach(() => { mock.restore(); });\n${assign}`)).toBe(true);
    expect(offends(`afterEach(() => { restoreFetch(); });\n${assign}`)).toBe(false);
  });

  test("a restore handle has to come from a stub helper call", () => {
    expect(
      offends(
        `const other = buildThing();\n` +
          `afterEach(() => { other.restore(); });\n` +
          `it("x", () => { stubFetch([]); });`,
      ),
    ).toBe(true);
  });

  test("restoreLeaves covers fetch alongside the module leaves", () => {
    const stub = (async () => new Response("")) as unknown as typeof fetch;
    globalThis.fetch = stub;

    restoreLeaves();

    expect(globalThis.fetch).toBe((globalThis as { __REAL_FETCH: typeof fetch }).__REAL_FETCH);
  });
});
