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
 * it needs no owner predicate. Declaring a site here is the only way it is
 * exempted, and an entry matching no call site fails the suite — a licence
 * cannot outlive the write it was granted for.
 */
const SERVER_KEYED: Record<string, string> = {
  "lib/postgres/repositories/users.ts::updateUser":
    "the primary key IS user_id, so the owner predicate would be the same equality twice",
  "lib/postgres/repositories/session.ts::touch":
    "sessions is keyed on session_id and has no user_id column — its owner lives in user_user_id",
  "lib/postgres/repositories/items.ts::updateItemCursor":
    "item_id comes from the sync loop, never from a request body",
  "lib/postgres/repositories/items.ts::updateItemStatus":
    "item_id comes from the sync loop, never from a request body",
  "lib/postgres/repositories/items.ts::updateItemSyncStatus":
    "item_id comes from the sync loop, never from a request body",
  "lib/postgres/repositories/api_keys.ts::verifyApiKey":
    "key_id is read back from the server's own key_hash lookup, not supplied by the caller",
};

/**
 * Receivers that own an unrelated `update` method. Declaring one keeps the
 * candidate rule fails-closed: a table reached through a renamed local still
 * has to answer for its owner predicate, and any new non-table `update` has to
 * be named here before the suite passes.
 */
const NOT_A_TABLE: Record<string, string> = {
  "lib/plaid/webhook.ts::hasher":
    "a crypto Hash accumulating the raw body for signature comparison",
};

interface UpdateCall {
  file: string;
  site: string;
  receiver: string;
  line: number;
  scoped: boolean;
}

/** `undefined` and `void 0` both leave the slot empty as far as the WHERE goes. */
const isAbsent = (node: ts.Node): boolean =>
  (ts.isIdentifier(node) && node.text === "undefined") || ts.isVoidExpression(node);

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

/**
 * Only a call on a plain identifier counts. That excludes the inline hashing
 * chain `createHash(plaintext).update(…)`, whose receiver is a call, while
 * still catching a table reached through a local binding.
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
        file: fileName,
        site: `${fileName}::${enclosingName(node)}`,
        receiver: node.expression.expression.text,
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

    expect(
      collectUpdateCalls(fixture, "fixture.ts").map((c) => `${c.site} scoped=${c.scoped}`),
    ).toEqual([
      "fixture.ts::omitted scoped=false",
      "fixture.ts::filledWithUndefined scoped=false",
      "fixture.ts::scoped scoped=true",
    ]);
  });

  it("reaches every write it claims to police", () => {
    const sites = serverCalls.map((c) => c.site);
    for (const exempted of Object.keys(SERVER_KEYED)) expect(sites).toContain(exempted);
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
      .filter((c) => !c.scoped && !(c.site in SERVER_KEYED))
      .map((c) => `${c.site}:${c.line}`);
    expect(unscoped).toEqual([]);
  });
});
