import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import ts from "typescript";

/**
 * `Table.update`'s fourth parameter is the owner predicate: supplying it ANDs
 * `user_id = $N` onto the WHERE, and leaving it out emits an UPDATE keyed on
 * the primary key alone. Any write whose key can be steered by a request body
 * is cross-user-mutable without it.
 *
 * Arity cannot express the invariant, because the slot can be filled with
 * `undefined` and still be absent — `Table.update` treats the two identically.
 * So the scan reads the argument rather than counting arguments.
 */
const SCOPE_ARGUMENT_INDEX = 3;

/**
 * The whole server, not the repository layer alone. A key supplied by a client
 * arrives in a route, so bounding this scan to the layer where the tables are
 * declared would leave the surface the keys actually reach ungoverned.
 */
const SCAN_ROOT = path.resolve(import.meta.dir, "../../..");

/**
 * Writes whose key cannot reach them from a request body, each with the reason
 * it needs no owner predicate. Declaring a write here is the only way it is
 * exempted, and an entry matching no call site fails the suite — a licence
 * cannot outlive the write it was granted for.
 *
 * The key carries the receiver as well as the function, because a licence is
 * granted to a statement and not to a name. Keyed on the function alone it
 * would blanket every unscoped `.update` that function later grows, including
 * ones on other tables: a write on a client-supplied key added beside an
 * exempted one would inherit a reason written about a different table.
 */
const SERVER_KEYED: Record<string, string> = {
  "lib/postgres/repositories/session.ts::touch::sessionsTable":
    "sessions is keyed on session_id and has no user_id column — its owner lives in user_user_id",
  "lib/postgres/repositories/items.ts::updateItemSyncStatus::itemsTable":
    "the scheduled sync loop walks every item server-side; item_id never crosses a request boundary",
  "lib/postgres/repositories/api_keys.ts::verifyApiKey::apiKeysTable":
    "key_id is read back from the server's own key_hash lookup, not supplied by the caller",
};

/** The write a licence is granted to: which statement, on which table. */
const exemptionKey = (call: UpdateCall): string => `${call.site}::${call.receiver}`;

/**
 * Receivers that own an unrelated `update` method. Every `.update` in the scan
 * is a candidate whatever its receiver is spelled like, so a non-table one has
 * to be named here before the suite passes. Restricting the candidate rule to
 * a receiver shape instead would fail OPEN — a table reached through a
 * namespace object, a struct field or `this` writes the same row as one
 * reached through a local, and is invisible to a scan that only reads plain
 * identifiers.
 */
const NOT_A_TABLE: Record<string, string> = {
  "lib/plaid/webhook.ts::hasher":
    "a crypto Hash accumulating the raw body for signature comparison",
  'lib/postgres/repositories/api_keys.ts::createHash("sha256")':
    "an inline crypto Hash chain over the key plaintext",
};

interface UpdateCall {
  file: string;
  site: string;
  receiver: string;
  owner: string;
  line: number;
  scoped: boolean;
}

/**
 * The owner predicate has to be spelled like one: `user_id`, `userId`, or a
 * property access ending in either. Reading the argument is all a syntactic
 * scan can do, so it vouches only for spellings that say what the value is —
 * an omitted slot, `undefined`, `void 0` and a local whose type admits
 * `undefined` are all indistinguishable to it, and the last one reaches the
 * WHERE as no predicate at all. A new spelling is a reviewable edit here; a
 * write this scan silently blessed is not.
 */
const OWNER_NAMES = new Set(["user_id", "userId"]);

const isOwnerExpression = (node: ts.Expression | undefined): boolean => {
  if (!node) return false;
  if (ts.isIdentifier(node)) return OWNER_NAMES.has(node.text);
  if (ts.isPropertyAccessExpression(node)) return OWNER_NAMES.has(node.name.text);
  return false;
};

/**
 * The name a reader would use for the call's home. A `const updated = await
 * x.update(…)` binding is not it, so a variable only answers once the climb has
 * crossed a function boundary — which is what lets a handler passed straight to
 * `new Route(…)` report the route it belongs to instead of nothing.
 */
const enclosingName = (node: ts.Node): string => {
  let crossedFunction = false;
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) {
      return current.name && ts.isIdentifier(current.name) ? current.name.text : "<anonymous>";
    }
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const { parent } = current;
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
      crossedFunction = true;
    }
    if (crossedFunction && ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      return current.name.text;
    }
  }
  return "<module>";
};

/** The expression a `.update` call is made on, however the member is reached. */
const updateReceiver = (node: ts.CallExpression): ts.Expression | undefined => {
  const callee = node.expression;
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === "update") {
    return callee.expression;
  }
  if (
    ts.isElementAccessExpression(callee) &&
    ts.isStringLiteralLike(callee.argumentExpression) &&
    callee.argumentExpression.text === "update"
  ) {
    return callee.expression;
  }
  return undefined;
};

/** Every `.update` call in the file, classified. Nothing is filtered out here:
 *  a receiver this scan cannot vouch for answers for its owner predicate like
 *  any other, and is cleared only by a `NOT_A_TABLE` entry. */
const collectUpdateCalls = (source: ts.SourceFile, fileName: string): UpdateCall[] => {
  const calls: UpdateCall[] = [];

  const visit = (node: ts.Node): void => {
    const receiver = ts.isCallExpression(node) ? updateReceiver(node) : undefined;
    if (receiver) {
      const call = node as ts.CallExpression;
      const scopeArgument = call.arguments[SCOPE_ARGUMENT_INDEX];
      calls.push({
        file: fileName,
        site: `${fileName}::${enclosingName(call)}`,
        receiver: receiver.getText(source),
        owner: scopeArgument ? scopeArgument.getText(source) : "<omitted>",
        line: source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1,
        scoped: isOwnerExpression(scopeArgument),
      });
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return calls;
};

const parse = (fileName: string, text: string): ts.SourceFile =>
  ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) return [];
    return [full];
  });

const serverCalls = sourceFiles(SCAN_ROOT).flatMap((full) => {
  const relative = path.relative(SCAN_ROOT, full);
  return collectUpdateCalls(parse(relative, readFileSync(full, "utf8")), relative);
});

/** A receiver named here is not a database table, so it has no owner to scope to. */
const isTableWrite = (call: UpdateCall): boolean =>
  !(`${call.file}::${call.receiver}` in NOT_A_TABLE);

describe("server updates carry the owner predicate", () => {
  it("vouches only for an owner predicate it can read as one", () => {
    const fixture = parse(
      "fixture.ts",
      `
        const omitted = async () => { await fooTable.update(id, row); };
        const filledWithUndefined = async () => {
          await fooTable.update(id, row, undefined, undefined, client);
        };
        const filledWithNullableLocal = async () => {
          const owner: string | undefined = undefined;
          await fooTable.update(id, row, undefined, owner);
        };
        const throughNamespace = async () => { await tables.fooTable.update(id, row); };
        const throughElementAccess = async () => { await tables["fooTable"]["update"](id, row); };
        const scoped = async () => { await fooTable.update(id, row, undefined, user.user_id); };
        const scopedByParameter = async (userId: string) => {
          await fooTable.update(id, row, undefined, userId);
        };
        const hashing = (plaintext: string) => createHash("sha256").update(plaintext).digest("hex");
      `,
    );

    expect(
      collectUpdateCalls(fixture, "fixture.ts").map(
        (c) => `${c.site} receiver=${c.receiver} owner=${c.owner} scoped=${c.scoped}`,
      ),
    ).toEqual([
      "fixture.ts::omitted receiver=fooTable owner=<omitted> scoped=false",
      "fixture.ts::filledWithUndefined receiver=fooTable owner=undefined scoped=false",
      "fixture.ts::filledWithNullableLocal receiver=fooTable owner=owner scoped=false",
      "fixture.ts::throughNamespace receiver=tables.fooTable owner=<omitted> scoped=false",
      'fixture.ts::throughElementAccess receiver=tables["fooTable"] owner=<omitted> scoped=false',
      "fixture.ts::scoped receiver=fooTable owner=user.user_id scoped=true",
      "fixture.ts::scopedByParameter receiver=fooTable owner=userId scoped=true",
      'fixture.ts::hashing receiver=createHash("sha256") owner=<omitted> scoped=false',
    ]);
  });

  it("reaches every write it claims to police", () => {
    const sites = serverCalls.map((c) => c.site);
    const exemptedWrites = serverCalls.map(exemptionKey);
    for (const exempted of Object.keys(SERVER_KEYED)) expect(exemptedWrites).toContain(exempted);
    const receivers = serverCalls.map((c) => `${c.file}::${c.receiver}`);
    for (const declared of Object.keys(NOT_A_TABLE)) expect(receivers).toContain(declared);
    // The route layer is where a client-supplied key arrives, so a scan that
    // never leaves the repository layer would pass while missing the surface
    // this invariant exists for.
    expect(sites.some((site) => site.startsWith("routes/"))).toBe(true);
    expect(serverCalls.filter((c) => c.scoped).length).toBeGreaterThan(0);
  });

  it("leaves no write keyed on a client-supplied id unscoped", () => {
    const unscoped = serverCalls
      .filter(isTableWrite)
      .filter((c) => !c.scoped && !(exemptionKey(c) in SERVER_KEYED))
      .map((c) => `${c.site}:${c.line} receiver=${c.receiver} owner=${c.owner}`);
    expect(unscoped).toEqual([]);
  });
});
