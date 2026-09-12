import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import path from "path";
import ts from "typescript";

/**
 * `Table.update`'s fourth parameter is the owner predicate: supplying it ANDs
 * `user_id = $N` onto the WHERE, and leaving it out emits an UPDATE keyed on
 * the primary key alone. Any repository write whose key can be steered by a
 * request body is cross-user-mutable without it.
 *
 * Arity cannot express the invariant, because the slot can be filled with
 * `undefined` and still be absent — `Table.update` treats the two identically.
 * So the scan reads the argument rather than counting arguments, and it reads
 * every file in the layer rather than a hand-written enumeration, so a
 * repository added later is covered without a fresh audit.
 */
const SCOPE_ARGUMENT_INDEX = 3;

/**
 * Writes whose key cannot reach them from a request body, each with the reason
 * it needs no owner predicate. Declaring a site here is the only way it is
 * exempted, and an entry matching no call site fails the suite — a licence
 * cannot outlive the write it was granted for.
 */
const SERVER_KEYED: Record<string, string> = {
  "users.ts::updateUser":
    "the primary key IS user_id, so the owner predicate would be the same equality twice",
  "session.ts::touch":
    "sessions is keyed on session_id and has no user_id column — its owner lives in user_user_id",
  "items.ts::updateItemCursor": "item_id comes from the sync loop, never from a request body",
  "items.ts::updateItemStatus": "item_id comes from the sync loop, never from a request body",
  "items.ts::updateItemSyncStatus": "item_id comes from the sync loop, never from a request body",
  "api_keys.ts::verifyApiKey":
    "key_id is read back from the server's own key_hash lookup, not supplied by the caller",
};

interface UpdateCall {
  site: string;
  line: number;
  scoped: boolean;
}

/** `undefined` and `void 0` both leave the slot empty as far as the WHERE goes. */
const isAbsent = (node: ts.Node): boolean =>
  (ts.isIdentifier(node) && node.text === "undefined") || ts.isVoidExpression(node);

/**
 * The named function that owns the call. A `const updated = await x.update(…)`
 * binding is not it, which is why the climb stops only at a function node.
 */
const enclosingName = (node: ts.Node): string => {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) {
      return current.name && ts.isIdentifier(current.name) ? current.name.text : "<anonymous>";
    }
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const { parent } = current;
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    }
  }
  return "<top-level>";
};

/**
 * Only a call on a plain identifier counts — a table binding. That excludes the
 * hashing chain `createHash(plaintext).update(…)`, whose receiver is a call,
 * while still catching a table reached through a renamed local.
 */
const collectUpdateCalls = (source: ts.SourceFile, fileName: string): UpdateCall[] => {
  const calls: UpdateCall[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "update" &&
      ts.isIdentifier(node.expression.expression)
    ) {
      const scopeArgument = node.arguments[SCOPE_ARGUMENT_INDEX];
      calls.push({
        site: `${fileName}::${enclosingName(node)}`,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        scoped: scopeArgument !== undefined && !isAbsent(scopeArgument),
      });
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return calls;
};

const parse = (fileName: string, text: string): ts.SourceFile =>
  ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

const repositoryCalls = readdirSync(import.meta.dir)
  .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
  .flatMap((entry) =>
    collectUpdateCalls(parse(entry, readFileSync(path.join(import.meta.dir, entry), "utf8")), entry),
  );

describe("repository updates carry the owner predicate", () => {
  it("classifies an omitted and an `undefined` owner predicate alike", () => {
    const fixture = parse(
      "fixture.ts",
      `
        const omitted = async () => { await fooTable.update(id, row); };
        const filledWithUndefined = async () => {
          await fooTable.update(id, row, undefined, undefined, client);
        };
        const scoped = async () => { await fooTable.update(id, row, undefined, user.user_id); };
        const hashing = (plaintext: string) => createHash("sha256").update(plaintext).digest("hex");
      `,
    );

    expect(collectUpdateCalls(fixture, "fixture.ts").map((c) => `${c.site} scoped=${c.scoped}`))
      .toEqual([
        "fixture.ts::omitted scoped=false",
        "fixture.ts::filledWithUndefined scoped=false",
        "fixture.ts::scoped scoped=true",
      ]);
  });

  it("reaches every write it claims to police", () => {
    const sites = repositoryCalls.map((c) => c.site);
    for (const exempted of Object.keys(SERVER_KEYED)) expect(sites).toContain(exempted);
    expect(repositoryCalls.filter((c) => c.scoped).length).toBeGreaterThan(0);
  });

  it("leaves no write keyed on a client-supplied id unscoped", () => {
    const unscoped = repositoryCalls
      .filter((c) => !c.scoped && !(c.site in SERVER_KEYED))
      .map((c) => `${c.site}:${c.line}`);
    expect(unscoped).toEqual([]);
  });
});
