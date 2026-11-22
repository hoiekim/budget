/**
 * The database a server start leaves behind: every table, column, index and
 * constraint in `public`, compared with what the Bun server creates. The Bun
 * server's schema is checked in as `fixtures/schema.json`; after a deliberate
 * schema change, write it again with
 *
 *   CONFORMANCE_TARGET=bun CONFORMANCE_UPDATE_FIXTURES=1 bun test tests/schema.test.ts
 *
 * The fixture holds the catalogs' own wording of types, defaults and
 * constraints, as PostgreSQL 16 (the version `docker-compose.yml` runs) gives
 * it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, TARGET, startStack, type Stack } from "../harness";

const FIXTURE = path.join(REPO_ROOT, "conformance", "fixtures", "schema.json");
const UPDATE = process.env.CONFORMANCE_UPDATE_FIXTURES === "1";

interface Schema {
  columns: Record<string, unknown>[];
  indexes: Record<string, unknown>[];
  constraints: Record<string, unknown>[];
  functions: Record<string, unknown>[];
}

// Names sort bytewise (`COLLATE "C"`), so the order does not depend on the
// locale the Postgres instance was set up with.
const COLUMNS = `
  SELECT table_name::text, column_name::text, data_type::text, udt_name::text,
         character_maximum_length::int, numeric_precision::int, numeric_scale::int,
         is_nullable::text, column_default::text
  FROM information_schema.columns
  WHERE table_schema = 'public'
  ORDER BY table_name::text COLLATE "C", ordinal_position`;

const INDEXES = `
  SELECT tablename::text, indexname::text, indexdef
  FROM pg_indexes
  WHERE schemaname = 'public'
  ORDER BY tablename::text COLLATE "C", indexname::text COLLATE "C"`;

const CONSTRAINTS = `
  SELECT rel.relname::text AS table_name, con.conname::text AS constraint_name,
         con.contype::text AS constraint_type, pg_get_constraintdef(con.oid) AS definition
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace ns ON ns.oid = rel.relnamespace
  WHERE ns.nspname = 'public'
  ORDER BY rel.relname::text COLLATE "C", con.conname::text COLLATE "C"`;

// The app's own SQL functions (extension functions such as pg_trgm's are
// left out), with their whole definition: the body, volatility and so on.
const FUNCTIONS = `
  SELECT p.proname::text AS name, pg_get_function_identity_arguments(p.oid) AS arguments,
         pg_get_functiondef(p.oid) AS definition
  FROM pg_proc p
  JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public'
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  ORDER BY p.proname::text COLLATE "C", 2`;

/** Rows as the plain values a JSON file holds. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const readSchema = async (stack: Stack): Promise<Schema> =>
  plain({
    columns: await stack.db.query(COLUMNS),
    indexes: await stack.db.query(INDEXES),
    constraints: await stack.db.query(CONSTRAINTS),
    functions: await stack.db.query(FUNCTIONS),
  });

let stack: Stack;
let actual: Schema;
let expected: Schema;

beforeAll(async () => {
  stack = await startStack();
  actual = await readSchema(stack);
  if (UPDATE) {
    // The fixture is the Bun server's schema by definition; written from the
    // Rust server it would only ever agree with itself.
    if (TARGET !== "bun") throw new Error("CONFORMANCE_UPDATE_FIXTURES writes the Bun server's schema: run it with CONFORMANCE_TARGET=bun");
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
  }
  expected = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
});
afterAll(() => stack?.stop());

/** The distinct values of `key` among `rows`, in order. */
const names = (rows: Record<string, unknown>[], key: string): unknown[] => [...new Set(rows.map((row) => row[key]))];

describe("the schema a server start creates", () => {
  test("has the tables the Bun server creates", () => {
    expect(names(actual.columns, "table_name")).toEqual(names(expected.columns, "table_name"));
  });

  test("has the same columns, in the same order, of the same types, nullability and defaults", () => {
    expect(actual.columns).toEqual(expected.columns);
  });

  test("has the same indexes", () => {
    expect(actual.indexes).toEqual(expected.indexes);
  });

  test("has the same primary keys, foreign keys and unique constraints", () => {
    expect(actual.constraints).toEqual(expected.constraints);
  });

  // The second start finds every table there and runs the column migration
  // over it: it must accept each column's type as it is and add nothing.
  test("has the same SQL functions, defined the same way", () => {
    expect(actual.functions).toEqual(expected.functions);
  });

  test("is left as it is by a restart", async () => {
    await stack.restart();
    expect(await readSchema(stack)).toEqual(expected);
  });
});
