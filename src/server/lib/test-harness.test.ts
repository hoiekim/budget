import { describe, test, expect, afterAll } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import ts from "typescript";
import { envReads } from "../../../scripts/env-scan";
import { restoreFetch, restoreLeaves, restoreEnv } from "test-helpers";

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
// Per global, not pooled: a restorer puts back the one global it names, so a
// file whose teardown calls only `restoreEnv` has restored no `fetch` and a
// file whose teardown calls only `restoreFetch` has restored no env. Pooling
// them lets either scan accept the other's restorer and report a leak clean.
const FETCH_RESTORERS = ["restoreFetch", "restoreLeaves"];
const ENV_RESTORERS = ["restoreEnv", "restoreLeaves"];
// Same trees the sibling env scan walks, so a knob added outside `src` is
// still seen. The shared extractor refuses an access it cannot resolve rather
// than dropping it, which is what keeps this from passing on a read shape it
// does not know.
const ENV_SCAN_ROOTS = ["src", "scripts", "vite.config.ts", "eslint.config.js", "healthcheck.js"];
const STUB_HELPERS = ["stubFetch"];
const TEARDOWN = ["afterAll", "afterEach"];
// The detector and the restorer have to name the same set: a name missing
// from this list leaks past the scan, and one missing from `restoreEnv` leaks
// past the restore. Deriving it from the snapshot leaves one copy to keep. A
// prefix pattern would not do, since it matches knobs the snapshot does not
// carry.
const MARKET_DATA_ENV = Object.keys(
  (globalThis as { __REAL_ENV: Record<string, string | undefined> }).__REAL_ENV,
);

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
  (restorers: string[], handles: string[]) =>
  (node: ts.Node): boolean =>
    (ts.isIdentifier(node) && restorers.includes(node.text)) ||
    (ts.isPropertyAccessExpression(node) &&
      node.name.text === "restore" &&
      ts.isIdentifier(node.expression) &&
      handles.includes(node.expression.text));

/** A teardown hook whose callback reaches one of `restorers`. */
const restoresIn = (
  source: ts.SourceFile,
  restorers: string[],
  handles: string[],
): boolean =>
  some(
    source,
    (node) =>
      ts.isCallExpression(node) &&
      TEARDOWN.includes(node.expression.getText(source)) &&
      node.arguments.some((argument) => some(argument, isRestorer(restorers, handles))),
  );

const restoresFetch = (source: ts.SourceFile, handles: string[]): boolean =>
  restoresIn(source, FETCH_RESTORERS, handles);

const restoresEnv = (source: ts.SourceFile): boolean =>
  restoresIn(source, ENV_RESTORERS, []);

/** A file that installs a stub and leaves it installed for the next one. */
const leaksFetch = (source: ts.SourceFile): boolean => {
  const helpers = stubHelperNames(source);
  return stubsFetch(source, helpers) && !restoresFetch(source, stubHandles(source, helpers));
};

/**
 * A write to the market-data env, which decides whether the market-data code
 * reaches the live upstream or short-circuits.
 *
 * It is the write that matters, not the read: a file that sets an API key and
 * does not put it back leaves every file after it taking the network branch,
 * and a fire-and-forget backfill started under that key outlives its own file
 * and lands its calls in whatever stub is installed when they resolve.
 */
const assignsMarketDataEnv = (node: ts.Node, source: ts.SourceFile): boolean => {
  if (!ts.isBinaryExpression(node)) return false;
  if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  const target = node.left;
  if (!ts.isPropertyAccessExpression(target)) return false;
  if (target.expression.getText(source) !== "process.env") return false;
  return MARKET_DATA_ENV.includes(target.name.text);
};

/**
 * A teardown hook that writes the env back by hand instead of calling a
 * restorer.
 *
 * A hand-rolled restore puts back a value the file read on the way in, and a
 * file that sets the env at module scope reads its own value back — so the
 * "original" it restores is the one it just installed, and the restore is a
 * no-op that looks thorough.
 */
const restoresEnvByHand = (source: ts.SourceFile): boolean =>
  some(
    source,
    (node) =>
      ts.isCallExpression(node) &&
      TEARDOWN.includes(node.expression.getText(source)) &&
      node.arguments.some((argument) =>
        some(argument, (inner) => assignsMarketDataEnv(inner, source)),
      ),
  );

/** A file that sets market-data env and does not hand it back to the snapshot. */
const leaksEnv = (source: ts.SourceFile): boolean =>
  some(source, (node) => assignsMarketDataEnv(node, source)) &&
  (!restoresEnv(source) || restoresEnvByHand(source));

const offendsEnv = (body: string): boolean => leaksEnv(parseSource("fixture.test.ts", body));

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

  test("a teardown that restores only the env has not restored fetch", () => {
    expect(
      offends(
        `afterEach(() => { restoreEnv(); });\n` + `it("x", () => { stubFetch([]); });`,
      ),
    ).toBe(true);
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

describe("market-data env", () => {
  afterAll(restoreEnv);

  test("every test file that sets it restores it in a teardown hook", () => {
    const offenders = testFiles(SRC)
      .filter((file) => leaksEnv(parse(file)))
      .map((file) => path.relative(SRC, file));

    expect(offenders).toEqual([]);
  });

  // Driven off a substituted snapshot rather than the ambient one: the real
  // snapshot carries whatever the developer's own environment holds, and
  // `.env.example` ships POLYGON_API_KEY uncommented, so a test that only
  // asserts the delete branch when that name happens to be unset is silently
  // vacuous on exactly the machines most likely to run it.
  const withSnapshot = (snapshot: Record<string, string | undefined>, body: () => void) => {
    const target = globalThis as { __REAL_ENV: Record<string, string | undefined> };
    const real = target.__REAL_ENV;
    target.__REAL_ENV = snapshot;
    try {
      body();
    } finally {
      target.__REAL_ENV = real;
      restoreEnv();
    }
  };

  test("restoreEnv deletes a name the snapshot found unset", () => {
    withSnapshot({ POLYGON_API_KEY: undefined }, () => {
      process.env.POLYGON_API_KEY = "test-key";

      restoreEnv();

      // Not `toBeUndefined` alone: assigning `undefined` to process.env stores
      // the string "undefined", which is truthy and reads as a real key.
      expect("POLYGON_API_KEY" in process.env).toBe(false);
    });
  });

  // The detector derives its names from the snapshot; these assert the
  // restorer covers that same set, in both of its branches.
  test("restoreEnv puts back every name the snapshot carries", () => {
    const sentinel = Object.fromEntries(MARKET_DATA_ENV.map((name) => [name, `snap-${name}`]));

    withSnapshot(sentinel, () => {
      for (const name of MARKET_DATA_ENV) process.env[name] = "clobbered";

      restoreEnv();

      for (const name of MARKET_DATA_ENV) expect(process.env[name]).toBe(`snap-${name}`);
    });
  });

  // The snapshot is the single source of truth for which names the scan
  // watches, so a knob the product reads but nobody snapshotted would narrow
  // the guard silently rather than widen it.
  test("the snapshot carries every market-data name the product reads", () => {
    const { read } = envReads(ENV_SCAN_ROOTS);
    const unsnapshotted = [...read]
      .filter((name) => /^(?:POLYGON|YAHOO)_/.test(name) && !MARKET_DATA_ENV.includes(name))
      .sort();

    expect(unsnapshotted).toEqual([]);
  });

  test("restoreEnv deletes every name the snapshot found unset", () => {
    const unset = Object.fromEntries(MARKET_DATA_ENV.map((name) => [name, undefined]));

    withSnapshot(unset, () => {
      for (const name of MARKET_DATA_ENV) process.env[name] = "leaked";

      restoreEnv();

      for (const name of MARKET_DATA_ENV) expect(name in process.env).toBe(false);
    });
  });

  test("the scan sees a bare set, and a set paired with a teardown restore", () => {
    expect(offendsEnv(`it("x", () => { process.env.POLYGON_API_KEY = "k"; });`)).toBe(true);
    expect(
      offendsEnv(
        `afterAll(restoreLeaves);\n` + `it("x", () => { process.env.POLYGON_API_KEY = "k"; });`,
      ),
    ).toBe(false);
    expect(offendsEnv(`it("x", () => { process.env.OTHER_THING = "k"; });`)).toBe(false);
  });

  test("a teardown that restores only fetch has not restored the env", () => {
    expect(
      offendsEnv(
        `afterEach(() => { restoreFetch(); });\n` +
          `it("x", () => { process.env.POLYGON_API_KEY = "k"; });`,
      ),
    ).toBe(true);
  });

  test("the scan rejects a hand-rolled restore, which can put back a leaked value", () => {
    expect(
      offendsEnv(
        `const original = process.env.POLYGON_API_KEY;\n` +
          `afterAll(() => { process.env.POLYGON_API_KEY = original; });\n` +
          `it("x", () => { process.env.POLYGON_API_KEY = "k"; });`,
      ),
    ).toBe(true);
  });
});
