import { describe, test, expect, mock, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";

const mockQuery = mock(async (_sql: string, _values?: unknown[]) => ({
  rows: [] as unknown[],
  rowCount: 0 as number | null,
}));

class FakePool {
  query = mockQuery;
  end = async () => {};
  connect = async () => ({ query: mockQuery, release: () => {} });
}

mock.module("pg", () => ({
  Pool: FakePool,
  types: { setTypeParser: () => {} },
  default: { Pool: FakePool, types: { setTypeParser: () => {} } },
}));

const models = await import("./index");
const { USER_ID, UPDATED } = models;
type IndexDefinition = { column: string } | { columns: string[] };

afterAll(restoreLeaves);

// Derived from the barrel rather than hand-listed, so a table added later is
// covered without anyone remembering to update this file. `initialize.ts` holds
// the boot registry but does not export it, and importing it here would pull in
// the repositories and the server logger for no benefit.
type IndexedTable = { name: string; indexes: IndexDefinition[] };

const isTable = (v: unknown): v is IndexedTable =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as IndexedTable).name === "string" &&
  Array.isArray((v as IndexedTable).indexes);

const tables = Object.values(models).filter(isTable);

const columnsOf = (idx: IndexDefinition): string[] =>
  "columns" in idx ? idx.columns : [idx.column];

describe("index definitions carry no leftmost-prefix redundancy", () => {
  // Guards the derivation above: if the barrel filter silently matched nothing,
  // every test.each below would vacuously pass on an empty table list.
  test("the barrel yields the full table registry", () => {
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.map((t) => t.name)).toContain("transaction_pairs");
  });

  // A btree on (a, b) already serves every `WHERE a = ?` lookup as a leftmost-
  // prefix scan, so a standalone (a) alongside it is pure write amplification:
  // two overlapping trees maintained on every INSERT/UPDATE/soft-delete for one
  // tree's worth of read benefit. Asserted across every table rather than the
  // four this issue named, so a new composite cannot reintroduce the pattern.
  test.each(tables.map((t) => [t.name, t] as const))(
    "%s has no single-column index that is the leftmost prefix of a composite",
    (_name, table) => {
      const composites = table.indexes.map(columnsOf).filter((cols) => cols.length > 1);
      const singles = table.indexes.map(columnsOf).filter((cols) => cols.length === 1);

      const redundant = singles
        .map(([col]) => col)
        .filter((col) => composites.some((cols) => cols[0] === col));

      expect(redundant).toEqual([]);
    },
  );

  // The other half of the invariant: dropping the standalone `user_id` entries
  // is only safe while the composite that subsumes them exists. If a future
  // change removes the composite, these tables would be left with no `user_id`
  // index at all and every per-user read becomes a seq scan.
  test.each([
    ["transactions", models.transactionsTable],
    ["investment_transactions", models.investmentTransactionsTable],
    ["split_transactions", models.splitTransactionsTable],
    ["snapshots", models.snapshotsTable],
    ["transaction_pairs", models.transactionPairsTable],
  ] as const)("%s still indexes user_id via the (user_id, updated) composite", (_name, table) => {
    expect(table.indexes.map(columnsOf)).toContainEqual([USER_ID, UPDATED]);
  });
});
