/**
 * Compares what two databases hold, table by table: for checking the Rust
 * server against the Bun server on real data, each run on its own copy of the
 * same database.
 *
 *   bun conformance/compare-databases.ts postgres://user:pass@host/copy_bun postgres://user:pass@host/copy_rust
 *
 * Rows are compared as sets, so their order does not matter. Left out of the
 * comparison: when a row was written (its timestamp columns, except a
 * snapshot's date), the sessions table, and ids one database made up that the
 * other did not (a random id, or text that embeds one), which are read as the
 * same placeholder in both. Exits 1 when the databases differ.
 */
import { SQL } from "bun";

const [first, second] = process.argv.slice(2);
if (!first || !second) {
  console.error("usage: bun conformance/compare-databases.ts <postgres url> <postgres url>");
  process.exit(2);
}

/** Written by the server whenever it stores a row, so two runs never agree on them. */
const WRITE_TIME_TYPES = new Set(["timestamp with time zone", "timestamp without time zone"]);
const KEPT_TIME_COLUMNS = new Set(["snapshots.snapshot_date"]);
const SKIPPED_TABLES = new Set(["sessions"]);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EXAMPLES = 5;

type Row = Record<string, unknown>;

const read = async (url: string): Promise<Map<string, Row[]>> => {
  const sql = new SQL(url);
  try {
    const columns: { table_name: string; column_name: string; data_type: string }[] = await sql`
      SELECT c.table_name, c.column_name, c.data_type
      FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name, c.ordinal_position`;
    const kept = new Map<string, string[]>();
    for (const { table_name, column_name, data_type } of columns) {
      if (SKIPPED_TABLES.has(table_name)) continue;
      const list = kept.get(table_name) ?? [];
      if (!WRITE_TIME_TYPES.has(data_type) || KEPT_TIME_COLUMNS.has(`${table_name}.${column_name}`)) list.push(column_name);
      kept.set(table_name, list);
    }
    const tables = new Map<string, Row[]>();
    for (const [table, names] of kept) {
      const list = names.map((name) => `"${name}"`).join(", ");
      tables.set(table, await sql.unsafe(`SELECT ${list} FROM "${table}"`));
    }
    return tables;
  } finally {
    await sql.close();
  }
};

/** A row as text with its keys sorted, so equal rows read the same. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) => {
    if (inner instanceof Date) return inner.toISOString();
    if (typeof inner === "bigint") return inner.toString();
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      return Object.fromEntries(Object.entries(inner as Row).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return inner;
  });

const idsIn = (tables: Map<string, string[]>): Set<string> => {
  const ids = new Set<string>();
  for (const rows of tables.values()) for (const row of rows) for (const id of row.match(UUID) ?? []) ids.add(id.toLowerCase());
  return ids;
};

const [rawA, rawB] = await Promise.all([read(first), read(second)]);
const textA = new Map([...rawA].map(([table, rows]) => [table, rows.map(canonical)]));
const textB = new Map([...rawB].map(([table, rows]) => [table, rows.map(canonical)]));

// An id both databases hold names the same row in both; one only one of them
// holds was made up by its server, and reads as a placeholder.
const idsA = idsIn(textA);
const idsB = idsIn(textB);
const shared = new Set([...idsA].filter((id) => idsB.has(id)));
const mask = (row: string) => row.replace(UUID, (id) => (shared.has(id.toLowerCase()) ? id : "<made-up id>"));

/** How many times each text occurs. */
const counted = (rows: string[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row, (counts.get(row) ?? 0) + 1);
  return counts;
};

/** The rows `a` holds more often than `b`, once per extra copy. */
const surplus = (a: Map<string, number>, b: Map<string, number>): string[] =>
  [...a].flatMap(([row, count]) => Array<string>(Math.max(0, count - (b.get(row) ?? 0))).fill(row));

let different = 0;
for (const table of [...new Set([...textA.keys(), ...textB.keys()])].sort()) {
  const rowsA = textA.get(table);
  const rowsB = textB.get(table);
  if (!rowsA || !rowsB) {
    different += 1;
    console.log(`${table}: only in the ${rowsA ? "first" : "second"} database`);
    continue;
  }
  const countsA = counted(rowsA.map(mask));
  const countsB = counted(rowsB.map(mask));
  const onlyA = surplus(countsA, countsB);
  const onlyB = surplus(countsB, countsA);
  if (onlyA.length === 0 && onlyB.length === 0) {
    console.log(`${table}: same (${rowsA.length} rows)`);
    continue;
  }
  different += 1;
  console.log(`${table}: ${rowsA.length} rows against ${rowsB.length}; ${onlyA.length} only in the first, ${onlyB.length} only in the second`);
  for (const row of onlyA.slice(0, EXAMPLES)) console.log(`  first:  ${row}`);
  for (const row of onlyB.slice(0, EXAMPLES)) console.log(`  second: ${row}`);
}

console.log(different === 0 ? "\nThe databases hold the same data." : `\n${different} table(s) differ.`);
process.exit(different === 0 ? 0 : 1);
