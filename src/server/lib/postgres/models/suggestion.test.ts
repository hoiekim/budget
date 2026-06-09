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

const { suggestionsTable } = await import("./suggestion");

afterAll(restoreLeaves);

describe("suggestionsTable — composite-PK Table guards", () => {
  // The Table framework's built-in helpers all assume a single-column primary
  // key. The `suggestions` table uses a composite PRIMARY KEY (transaction_id,
  // category_id), so calling those helpers would silently corrupt rows by
  // resolving on `this.primaryKey = "transaction_id"` while the actual key
  // shape is composite. These tests pin the runtime guard added to Table
  // (see `_assertSimplePrimaryKey` in models/base.ts) so a Stage 2 contributor
  // who reaches for `suggestionsTable.upsert(...)` gets a clear error instead
  // of a half-deleted row.

  const data = {
    transaction_id: "tx-1",
    user_id: "u-1",
    category_id: "cat-A",
    confidence: 0.85,
  };

  test("insert() throws — must use raw pool.query in repository", async () => {
    await expect(suggestionsTable.insert(data)).rejects.toThrow(
      /Table\.insert\(\) is not supported on 'suggestions'/,
    );
  });

  test("update() throws", async () => {
    await expect(suggestionsTable.update("tx-1", { confidence: 1 })).rejects.toThrow(
      /Table\.update\(\) is not supported on 'suggestions'/,
    );
  });

  test("upsert() throws — the obvious wrong-helper choice", async () => {
    await expect(suggestionsTable.upsert(data)).rejects.toThrow(
      /Table\.upsert\(\) is not supported on 'suggestions'/,
    );
  });

  test("hardDelete() throws — silently dropping ALL rows for a transaction would be the worst footgun", async () => {
    await expect(suggestionsTable.hardDelete("tx-1")).rejects.toThrow(
      /Table\.hardDelete\(\) is not supported on 'suggestions'/,
    );
  });

  test("bulkHardDelete() throws", async () => {
    await expect(suggestionsTable.bulkHardDelete(["tx-1"])).rejects.toThrow(
      /Table\.bulkHardDelete\(\) is not supported on 'suggestions'/,
    );
  });

  test("queryByIds() throws", async () => {
    await expect(suggestionsTable.queryByIds(["tx-1"])).rejects.toThrow(
      /Table\.queryByIds\(\) is not supported on 'suggestions'/,
    );
  });

  test("softDelete() throws (even though supportsSoftDelete=false, the guard fires first)", async () => {
    await expect(suggestionsTable.softDelete("tx-1")).rejects.toThrow(
      /Table\.softDelete\(\) is not supported on 'suggestions'/,
    );
  });

  test("query() (the filter-based read) is unaffected — it doesn't use primaryKey", async () => {
    mockQuery.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));
    await expect(suggestionsTable.query({ user_id: "u-1" })).resolves.toEqual([]);
  });
});

describe("suggestionsTable — schema invariants", () => {
  test("constraint list includes both the composite PK and the mutex CHECK", () => {
    const constraints = suggestionsTable.constraints.join("\n");
    expect(constraints).toMatch(/PRIMARY KEY\s*\(transaction_id,\s*category_id\)/);
    expect(constraints).toMatch(
      /CHECK\s*\(\s*NOT\s*\(\s*is_confirmed\s+AND\s+is_rejected\s*\)\s*\)/,
    );
  });

  test("schema has the four explicit-flag/timestamp columns NOT-NULL where appropriate", () => {
    const schema = suggestionsTable.schema as Record<string, string>;
    expect(schema.is_confirmed).toMatch(/BOOLEAN NOT NULL DEFAULT FALSE/);
    expect(schema.is_rejected).toMatch(/BOOLEAN NOT NULL DEFAULT FALSE/);
    expect(schema.confirmed_at).toMatch(/TIMESTAMPTZ/);
    expect(schema.engine_scored_at).toMatch(/TIMESTAMPTZ/);
    // confirmed_at + engine_scored_at intentionally allow NULL — they're stamped
    // only when the respective UPSERT helper fires.
    expect(schema.confirmed_at).not.toMatch(/NOT NULL/);
    expect(schema.engine_scored_at).not.toMatch(/NOT NULL/);
  });
});
