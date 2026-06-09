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

const { rejectedCategoriesTable } = await import("./rejected-category");

afterAll(restoreLeaves);

describe("rejectedCategoriesTable — composite-PK Table guards", () => {
  // The Table framework's built-in single-PK helpers must throw for this
  // table — composite PRIMARY KEY (transaction_id, category_id) means
  // `this.primaryKey` (= "transaction_id" alone) is not the row key.
  // The runtime guard `_assertSimplePrimaryKey` (from #496's review pass)
  // catches misuse before SQL goes out.

  const data = {
    transaction_id: "tx-1",
    user_id: "u-1",
    category_id: "cat-A",
  };

  test("insert() throws — must use raw pool.query in repository", async () => {
    await expect(rejectedCategoriesTable.insert(data)).rejects.toThrow(
      /Table\.insert\(\) is not supported on 'rejected_categories'/,
    );
  });

  test("upsert() throws — the obvious wrong-helper choice", async () => {
    await expect(rejectedCategoriesTable.upsert(data)).rejects.toThrow(
      /Table\.upsert\(\) is not supported on 'rejected_categories'/,
    );
  });

  test("hardDelete() throws — would otherwise drop all rows for a transaction_id, not just one (tx, cat) pair", async () => {
    await expect(rejectedCategoriesTable.hardDelete("tx-1")).rejects.toThrow(
      /Table\.hardDelete\(\) is not supported on 'rejected_categories'/,
    );
  });

  test("update() throws", async () => {
    await expect(
      rejectedCategoriesTable.update("tx-1", { rejected_at: "now" }),
    ).rejects.toThrow(/Table\.update\(\) is not supported on 'rejected_categories'/);
  });

  test("queryByIds() throws", async () => {
    await expect(rejectedCategoriesTable.queryByIds(["tx-1"])).rejects.toThrow(
      /Table\.queryByIds\(\) is not supported on 'rejected_categories'/,
    );
  });

  test("hardDeleteByColumn() throws", async () => {
    await expect(
      rejectedCategoriesTable.hardDeleteByColumn("transaction_id", "tx-1"),
    ).rejects.toThrow(
      /Table\.hardDeleteByColumn\(\) is not supported on 'rejected_categories'/,
    );
  });

  test("deleteByCondition() throws — 11th guarded method, also unsafe on composite PK", async () => {
    await expect(
      rejectedCategoriesTable.deleteByCondition("rejected_at", "<", "2025-01-01"),
    ).rejects.toThrow(
      /Table\.deleteByCondition\(\) is not supported on 'rejected_categories'/,
    );
  });

  test("query() (the filter-based read) is unaffected — it doesn't use primaryKey", async () => {
    mockQuery.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));
    await expect(rejectedCategoriesTable.query({ user_id: "u-1" })).resolves.toEqual([]);
  });
});

describe("rejectedCategoriesTable — schema invariants", () => {
  test("constraint list includes the composite PK", () => {
    const constraints = rejectedCategoriesTable.constraints.join("\n");
    expect(constraints).toMatch(
      /PRIMARY KEY\s*\(\s*transaction_id,\s*category_id\s*\)/,
    );
  });

  test("schema is minimal: only the 4 columns we need", () => {
    const cols = Object.keys(rejectedCategoriesTable.schema).sort();
    expect(cols).toEqual(
      ["category_id", "rejected_at", "transaction_id", "user_id"].sort(),
    );
  });

  test("rejected_at defaults to CURRENT_TIMESTAMP — so addRejection only needs to set the 3 NOT-NULL columns", () => {
    const schema = rejectedCategoriesTable.schema as Record<string, string>;
    expect(schema.rejected_at).toMatch(/TIMESTAMPTZ\s+DEFAULT\s+CURRENT_TIMESTAMP/);
  });
});
