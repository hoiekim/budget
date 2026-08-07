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

afterAll(restoreLeaves);

// Mirrors the `tables` registry in `initialize.ts`, which is module-private.
// Every table that boot creates indexes for must appear here, otherwise a new
// table can reintroduce a redundant index without tripping these guards.
const tables = [
  models.usersTable,
  models.sessionsTable,
  models.institutionsTable,
  models.securitiesTable,
  models.itemsTable,
  models.accountsTable,
  models.holdingsTable,
  models.transactionsTable,
  models.transactionPairsTable,
  models.investmentTransactionsTable,
  models.splitTransactionsTable,
  models.budgetsTable,
  models.sectionsTable,
  models.categoriesTable,
  models.snapshotsTable,
  models.chartsTable,
  models.apiKeysTable,
  models.rejectedCategoriesTable,
];

const columnsOf = (idx: { column: string } | { columns: string[] }): string[] =>
  "columns" in idx ? idx.columns : [idx.column];

describe("index definitions carry no leftmost-prefix redundancy (#645)", () => {
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
  ] as const)("%s still indexes user_id via the (user_id, updated) composite", (_name, table) => {
    expect(table.indexes.map(columnsOf)).toContainEqual([USER_ID, UPDATED]);
  });
});
