import { describe, it, expect, mock, afterAll } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import ts from "typescript";
import { createFakePg, restoreLeaves } from "test-helpers";

const { pg } = createFakePg();
mock.module("pg", () => pg);
const models = await import("../models");
afterAll(restoreLeaves);

/**
 * How each `Table` write takes its owner, and so what the scan reads to vouch
 * for it. Leaving the owner out of any of them writes on the primary key alone,
 * which makes a key steerable by a request body cross-user-mutable.
 *
 * - `argument`: an owner value at this position. `update` ANDs it onto the
 *   WHERE; the soft deletes filter on it.
 * - `filter`: an object at this position whose `user_id` key holds the owner.
 * - `columns`: the `DO UPDATE SET` allowlist at this position. Left out, an
 *   upsert sets every supplied column on conflict, `user_id` included, so a
 *   colliding key reassigns another user's row; the allowlist has to leave
 *   `user_id` out, provably, unless the row written is a literal with no
 *   `user_id` key, which no conflict can set. This proves only that the owner
 *   can't be reassigned: the statement has no owner predicate, so a colliding
 *   key still overwrites the other row's allowlisted columns, and keeping keys
 *   from colliding stays with the caller.
 * - `none`: no owner slot at all, so only a licence below clears the call.
 *
 * `insert` is left out: a colliding key fails it rather than writing the
 * existing row. Writes through raw SQL are outside this scan altogether.
 *
 * Arity cannot express any of these, because a slot can be filled with
 * `undefined` and still be absent. So the scan reads the argument rather than
 * counting arguments.
 */
type OwnerRule =
  | { kind: "argument" | "filter" | "columns"; index: number }
  | { kind: "none" };

const WRITE_VERBS: Record<string, OwnerRule> = {
  update: { kind: "argument", index: 3 },
  softDelete: { kind: "argument", index: 1 },
  bulkSoftDelete: { kind: "filter", index: 1 },
  bulkSoftDeleteByColumn: { kind: "argument", index: 2 },
  bulkSoftDeleteByRelatedColumn: { kind: "argument", index: 2 },
  upsert: { kind: "columns", index: 1 },
  upsertMany: { kind: "columns", index: 1 },
  hardDelete: { kind: "none" },
  bulkHardDelete: { kind: "none" },
  hardDeleteByColumn: { kind: "none" },
  deleteByCondition: { kind: "none" },
};

type DeclaredTable = { name: string; primaryKey: string; schema: Record<string, unknown> };
const isDeclaredTable = (v: unknown): v is DeclaredTable =>
  !!v && typeof v === "object" && "schema" in v && "primaryKey" in v && "name" in v;

/**
 * Each table's owner column, by its exported name: `user_id`, or a column
 * ending in `_user_id` (sessions keep theirs in `user_user_id`). A table with
 * neither is shared data with no owner to scope to. When the owner column is
 * the primary key, as on users, the row is the owner, and a write is scoped by
 * its key. Derived from the models barrel, so a table added later is
 * classified without anyone listing it.
 */
const TABLE_OWNERS = new Map(
  Object.entries(models)
    .filter((entry): entry is [string, DeclaredTable] => isDeclaredTable(entry[1]))
    .map(([exportName, table]) => {
      const columns = Object.keys(table.schema);
      const owner = columns.includes(models.USER_ID)
        ? models.USER_ID
        : (columns.find((column) => column.endsWith(`_${models.USER_ID}`)) ?? null);
      return [exportName, { owner, keyIsOwner: owner !== null && table.primaryKey === owner }] as const;
    }),
);

/** Model constants whose value is the owner column, whatever they are called. */
const OWNER_COLUMN_CONSTANTS = new Set(
  Object.entries(models)
    .filter(([, value]) => value === models.USER_ID)
    .map(([name]) => name),
);

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
  "lib/postgres/repositories/items.ts::updateItemSyncStatus::itemsTable.update":
    "the scheduled sync loop walks every item server-side; item_id never crosses a request boundary",
  "lib/postgres/repositories/api_keys.ts::verifyApiKey::apiKeysTable.update":
    "key_id is read back from the server's own key_hash lookup, not supplied by the caller",
  "lib/postgres/repositories/accounts.ts::upsertAccounts::accountsTable.upsert":
    "called only by the Plaid and SimpleFin syncs, with account_ids the provider issued for the user's own linked item",
  "lib/postgres/repositories/transactions.ts::upsertTransactions::transactionsTable.upsert":
    "called only by the Plaid and SimpleFin syncs, with transaction_ids the provider issued for the user's own linked item",
  "lib/postgres/repositories/investment_transactions.ts::upsertInvestmentTransactions::investmentTransactionsTable.upsert":
    "called only by the Plaid and SimpleFin syncs, with investment_transaction_ids the provider issued for the user's own linked item",
  "lib/postgres/repositories/session.ts::purgeSessions::sessionsTable.deleteByCondition":
    "deletes expired sessions by cookie expiry on a server timer; no caller-supplied key",
  "lib/postgres/repositories/session.ts::set::sessionsTable.upsert":
    "session_id is the server-issued id from the signed session cookie, never a request field",
  "lib/postgres/repositories/session.ts::destroy::sessionsTable.hardDelete":
    "session_id is the server-issued id from the signed session cookie, never a request field",
  "lib/postgres/repositories/session.ts::touch::sessionsTable.update":
    "session_id is the server-issued id from the signed session cookie, never a request field",
  "lib/postgres/repositories/users.ts::writeUser::usersTable.upsert":
    "seeds the admin and demo users at boot; no route writes a user",
  "lib/postgres/repositories/securities.ts::deleteSecurities::snapshotsTable.hardDeleteByColumn":
    "removes a global security's price snapshots by security_id; those rows carry no user_id, and security_id is never client-supplied here",
};

const exemptionKey = (call: WriteCall): string => `${call.site}::${call.receiver}.${call.verb}`;

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

interface WriteCall {
  file: string;
  site: string;
  receiver: string;
  verb: string;
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

const namesOwnerColumn = (node: ts.Node): boolean =>
  (ts.isIdentifier(node) && (OWNER_COLUMN_CONSTANTS.has(node.text) || node.text === models.USER_ID)) ||
  (ts.isStringLiteralLike(node) && node.text === models.USER_ID);

/**
 * An object literal with a `user_id` key, computed or plain, holding the owner.
 * A spread is refused: it can carry its own `user_id` and overwrite the owner.
 */
const isOwnerFilter = (node: ts.Expression | undefined): boolean =>
  !!node &&
  ts.isObjectLiteralExpression(node) &&
  !node.properties.some(ts.isSpreadAssignment) &&
  node.properties.some((property) => {
    if (!ts.isPropertyAssignment(property)) return false;
    const key = ts.isComputedPropertyName(property.name) ? property.name.expression : property.name;
    return namesOwnerColumn(key) && isOwnerExpression(property.initializer);
  });

/** Every name the file binds, with how many times: declarations, parameters, destructuring. */
const fileBindings = (source: ts.SourceFile): Map<string, number> => {
  const counts = new Map<string, number>();
  const visit = (node: ts.Node): void => {
    const name =
      ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node) ||
      ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)
        ? node.name
        : undefined;
    if (name && ts.isIdentifier(name)) counts.set(name.text, (counts.get(name.text) ?? 0) + 1);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return counts;
};

const MUTATING_METHODS = new Set(["push", "unshift", "splice", "fill", "copyWithin", "sort", "reverse"]);

/** Whether the file mutates the array a name holds, by a mutating method or an element assignment. */
const isMutated = (source: ts.SourceFile, name: string): boolean => {
  let mutated = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === name &&
      MUTATING_METHODS.has(node.expression.name.text)
    ) {
      mutated = true;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (ts.isElementAccessExpression(node.left) || ts.isPropertyAccessExpression(node.left)) &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === name
    ) {
      mutated = true;
    }
    if (!mutated) ts.forEachChild(node, visit);
  };
  visit(source);
  return mutated;
};

/**
 * An allowlist the scan can read in full and that leaves `user_id` out: an
 * array literal, inline or held by a module-level `const` that nothing else in
 * the file binds under the same name or mutates. Each entry is a string other
 * than `user_id`, or an imported column constant whose value isn't `user_id`;
 * a name the file declares itself could hold anything. A computed list
 * (`Object.keys(row).filter(…)`) or a spread is not readable, so it isn't
 * vouched for.
 */
const isOwnerSafeAllowlist = (node: ts.Expression | undefined, source: ts.SourceFile): boolean => {
  if (!node) return false;
  const bindings = fileBindings(source);
  let list: ts.Expression | undefined = node;
  if (ts.isIdentifier(node)) {
    if (bindings.get(node.text) !== 1 || isMutated(source, node.text)) return false;
    list = undefined;
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === node.text) list = declaration.initializer;
      }
    }
    if (!list) return false;
  }
  while (ts.isAsExpression(list) || ts.isSatisfiesExpression(list)) list = list.expression;
  return (
    ts.isArrayLiteralExpression(list) &&
    list.elements.every(
      (e) =>
        (ts.isStringLiteralLike(e) || (ts.isIdentifier(e) && !bindings.has(e.text))) && !namesOwnerColumn(e),
    )
  );
};

const isOwnerlessRow = (node: ts.Expression | undefined): boolean =>
  !!node &&
  ts.isObjectLiteralExpression(node) &&
  node.properties.every((property) => {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return false;
    const key = ts.isPropertyAssignment(property) && ts.isComputedPropertyName(property.name)
      ? property.name.expression
      : property.name;
    return !namesOwnerColumn(key);
  });

/** Writes whose first argument is the row's primary key. */
const KEYED_VERBS = new Set(["update", "softDelete", "hardDelete"]);

const isScoped = (
  rule: OwnerRule,
  call: ts.CallExpression,
  source: ts.SourceFile,
  keyIsOwner: boolean,
): boolean => {
  if (keyIsOwner) return KEYED_VERBS.has(verbOf(call)) && isOwnerExpression(call.arguments[0]);
  const argument = rule.kind === "none" ? undefined : call.arguments[rule.index];
  switch (rule.kind) {
    case "argument":
      return isOwnerExpression(argument);
    case "filter":
      return isOwnerFilter(argument);
    case "columns":
      return isOwnerSafeAllowlist(argument, source) || isOwnerlessRow(call.arguments[0]);
    case "none":
      return false;
  }
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

const writeTarget = (node: ts.CallExpression): { verb: string; receiver: ts.Expression } | undefined => {
  const callee = node.expression;
  if (ts.isPropertyAccessExpression(callee) && Object.hasOwn(WRITE_VERBS, callee.name.text)) {
    return { verb: callee.name.text, receiver: callee.expression };
  }
  if (
    ts.isElementAccessExpression(callee) &&
    ts.isStringLiteralLike(callee.argumentExpression) &&
    Object.hasOwn(WRITE_VERBS, callee.argumentExpression.text)
  ) {
    return { verb: callee.argumentExpression.text, receiver: callee.expression };
  }
  return undefined;
};

/** Every write call in the file, classified. Nothing is filtered out here: a
 *  receiver this scan cannot vouch for answers for its owner like any other,
 *  and is cleared only by a `NOT_A_TABLE` entry or an owner-less table. */
const verbOf = (call: ts.CallExpression): string => writeTarget(call)?.verb ?? "";

/** The table export a receiver names: the identifier itself, or the member a namespace reaches. */
const receiverTableName = (receiver: string): string => receiver.replace(/^.*[.\[]["']?/, "").replace(/["'\]]$/, "");

const collectWriteCalls = (source: ts.SourceFile, fileName: string): WriteCall[] => {
  const calls: WriteCall[] = [];

  const visit = (node: ts.Node): void => {
    const target = ts.isCallExpression(node) ? writeTarget(node) : undefined;
    if (target) {
      const call = node as ts.CallExpression;
      const rule = WRITE_VERBS[target.verb];
      const receiver = target.receiver.getText(source);
      const keyIsOwner = TABLE_OWNERS.get(receiverTableName(receiver))?.keyIsOwner ?? false;
      const argument = keyIsOwner ? call.arguments[0] : rule.kind === "none" ? undefined : call.arguments[rule.index];
      calls.push({
        file: fileName,
        site: `${fileName}::${enclosingName(call)}`,
        receiver,
        verb: target.verb,
        owner: argument ? argument.getText(source).replace(/\s+/g, " ") : "<omitted>",
        line: source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1,
        scoped: isScoped(rule, call, source, keyIsOwner),
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
  return collectWriteCalls(parse(relative, readFileSync(full, "utf8")), relative);
});

/** A receiver that names no table export is treated as owned, so an alias fails closed. */
const isOwnedTableWrite = (call: WriteCall): boolean =>
  !(`${call.file}::${call.receiver}` in NOT_A_TABLE) &&
  TABLE_OWNERS.get(receiverTableName(call.receiver))?.owner !== null;

describe("server writes carry the owner", () => {
  it("vouches only for an owner it can read as one", () => {
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
        const softDeleteScoped = async () => { await fooTable.softDelete(id, user.user_id); };
        const softDeleteBare = async () => { await fooTable.softDelete(id); };
        const filterScoped = async () => { await fooTable.bulkSoftDelete(ids, { [USER_ID]: user_id }); };
        const filterOtherKey = async () => { await fooTable.bulkSoftDelete(ids, { [ACCOUNT_ID]: user_id }); };
        const filterOmitted = async () => { await fooTable.bulkSoftDelete(ids); };
        const byColumnScoped = async () => { await fooTable.bulkSoftDeleteByColumn(ACCOUNT_ID, ids, user_id); };
        const FOO_COLUMNS = [AMOUNT, NAME] as const;
        const upsertAllowlisted = async () => { await fooTable.upsert(row, FOO_COLUMNS); };
        const upsertInlineAllowlist = async () => { await fooTable.upsertMany(rows, [AMOUNT], client); };
        const OWNING_COLUMNS = [AMOUNT, USER_ID];
        const upsertListWithOwner = async () => { await fooTable.upsert(row, OWNING_COLUMNS); };
        const upsertComputed = async () => { await fooTable.upsert(row, Object.keys(row)); };
        const upsertBare = async () => { await fooTable.upsert(row, undefined, client); };
        const upsertOwnerlessRow = async () => { await fooTable.upsert({ [SNAPSHOT_ID]: id, close_price }); };
        const upsertOwnedRow = async () => { await fooTable.upsert({ [SNAPSHOT_ID]: id, [USER_ID]: owner }); };
        const hardDelete = async () => { await fooTable.hardDelete(id); };
        const keyOwnerScoped = async () => { await usersTable.update(user.user_id, row); };
        const keyOwnerOther = async () => { await usersTable.update(targetId, row); };
        const keyOwnerUpsert = async () => { await usersTable.upsert(row); };
        const upsertShorthandOwner = async () => { await fooTable.upsert({ id, user_id }); };
        const upsertStringOwnerList = async () => { await fooTable.upsert(row, ["amount", "user_id"]); };
        const filterSpread = async () => {
          await fooTable.bulkSoftDelete(ids, { [USER_ID]: user.user_id, ...extra });
        };
        const SHADOWED_COLUMNS = [AMOUNT];
        const shadowing = async () => {
          const SHADOWED_COLUMNS = [USER_ID];
          await fooTable.upsert(row, SHADOWED_COLUMNS);
        };
        const PUSHED_COLUMNS = [AMOUNT];
        PUSHED_COLUMNS.push(USER_ID);
        const pushed = async () => { await fooTable.upsert(row, PUSHED_COLUMNS); };
        const LOCAL_OWNER = "user_id";
        const ALIASED_COLUMNS = [LOCAL_OWNER];
        const aliased = async () => { await fooTable.upsert(row, ALIASED_COLUMNS); };
      `,
    );

    expect(
      collectWriteCalls(fixture, "fixture.ts").map(
        (c) => `${c.site} ${c.receiver}.${c.verb} owner=${c.owner} scoped=${c.scoped}`,
      ),
    ).toEqual([
      "fixture.ts::omitted fooTable.update owner=<omitted> scoped=false",
      "fixture.ts::filledWithUndefined fooTable.update owner=undefined scoped=false",
      "fixture.ts::filledWithNullableLocal fooTable.update owner=owner scoped=false",
      "fixture.ts::throughNamespace tables.fooTable.update owner=<omitted> scoped=false",
      'fixture.ts::throughElementAccess tables["fooTable"].update owner=<omitted> scoped=false',
      "fixture.ts::scoped fooTable.update owner=user.user_id scoped=true",
      "fixture.ts::scopedByParameter fooTable.update owner=userId scoped=true",
      'fixture.ts::hashing createHash("sha256").update owner=<omitted> scoped=false',
      "fixture.ts::softDeleteScoped fooTable.softDelete owner=user.user_id scoped=true",
      "fixture.ts::softDeleteBare fooTable.softDelete owner=<omitted> scoped=false",
      "fixture.ts::filterScoped fooTable.bulkSoftDelete owner={ [USER_ID]: user_id } scoped=true",
      "fixture.ts::filterOtherKey fooTable.bulkSoftDelete owner={ [ACCOUNT_ID]: user_id } scoped=false",
      "fixture.ts::filterOmitted fooTable.bulkSoftDelete owner=<omitted> scoped=false",
      "fixture.ts::byColumnScoped fooTable.bulkSoftDeleteByColumn owner=user_id scoped=true",
      "fixture.ts::upsertAllowlisted fooTable.upsert owner=FOO_COLUMNS scoped=true",
      "fixture.ts::upsertInlineAllowlist fooTable.upsertMany owner=[AMOUNT] scoped=true",
      "fixture.ts::upsertListWithOwner fooTable.upsert owner=OWNING_COLUMNS scoped=false",
      "fixture.ts::upsertComputed fooTable.upsert owner=Object.keys(row) scoped=false",
      "fixture.ts::upsertBare fooTable.upsert owner=undefined scoped=false",
      "fixture.ts::upsertOwnerlessRow fooTable.upsert owner=<omitted> scoped=true",
      "fixture.ts::upsertOwnedRow fooTable.upsert owner=<omitted> scoped=false",
      "fixture.ts::hardDelete fooTable.hardDelete owner=<omitted> scoped=false",
      "fixture.ts::keyOwnerScoped usersTable.update owner=user.user_id scoped=true",
      "fixture.ts::keyOwnerOther usersTable.update owner=targetId scoped=false",
      "fixture.ts::keyOwnerUpsert usersTable.upsert owner=row scoped=false",
      "fixture.ts::upsertShorthandOwner fooTable.upsert owner=<omitted> scoped=false",
      'fixture.ts::upsertStringOwnerList fooTable.upsert owner=["amount", "user_id"] scoped=false',
      "fixture.ts::filterSpread fooTable.bulkSoftDelete owner={ [USER_ID]: user.user_id, ...extra } scoped=false",
      "fixture.ts::shadowing fooTable.upsert owner=SHADOWED_COLUMNS scoped=false",
      "fixture.ts::pushed fooTable.upsert owner=PUSHED_COLUMNS scoped=false",
      "fixture.ts::aliased fooTable.upsert owner=ALIASED_COLUMNS scoped=false",
    ]);
  });

  it("reads each table's owner column from the models", () => {
    const names = ["institutionsTable", "securitiesTable", "sessionsTable", "usersTable", "transactionsTable"];
    expect(Object.fromEntries(names.map((name) => [name, TABLE_OWNERS.get(name)]))).toEqual({
      institutionsTable: { owner: null, keyIsOwner: false },
      securitiesTable: { owner: null, keyIsOwner: false },
      sessionsTable: { owner: "user_user_id", keyIsOwner: false },
      usersTable: { owner: "user_id", keyIsOwner: true },
      transactionsTable: { owner: "user_id", keyIsOwner: false },
    });
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
    // Every verb with an owner slot is seen scoped somewhere, so a rule that
    // reads the wrong argument can't pass by rejecting everything into licences.
    const scopedVerbs = new Set(serverCalls.filter((c) => c.scoped).map((c) => c.verb));
    expect([...scopedVerbs].sort()).toEqual(
      ["bulkSoftDelete", "bulkSoftDeleteByColumn", "bulkSoftDeleteByRelatedColumn", "softDelete", "update", "upsert"].sort(),
    );
  });

  it("leaves no write keyed on a client-supplied id unscoped", () => {
    const unscoped = serverCalls
      .filter(isOwnedTableWrite)
      .filter((c) => !c.scoped && !(exemptionKey(c) in SERVER_KEYED))
      .map((c) => `${c.site}:${c.line} ${c.receiver}.${c.verb} owner=${c.owner}`);
    expect(unscoped).toEqual([]);
  });
});
