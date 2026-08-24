import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves, updateColumnsOf } from "test-helpers";

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

const { createTable } = await import("./base");

afterAll(restoreLeaves);

const widgetsTable = createTable({
  name: "widgets",
  primaryKey: "widget_id",
  schema: {
    widget_id: "VARCHAR(255) PRIMARY KEY",
    user_id: "VARCHAR(255)",
    label: "VARCHAR(255)",
    note: "VARCHAR(255)",
  },
});

beforeEach(() => {
  mockQuery.mockClear();
  mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 1 }));
});

const emittedSql = () => mockQuery.mock.calls[0][0] as string;

describe("Table.upsert conflict clause", () => {
  test("with no allowlist, every supplied column is rewritten — including the owner", async () => {
    await widgetsTable.upsert({ widget_id: "w-1", user_id: "u-1", label: "a" });
    const columns = updateColumnsOf(emittedSql());
    expect(columns).toContain("user_id");
    expect(columns).toContain("label");
    // The primary key is the conflict target and is never in the SET list.
    expect(columns).not.toContain("widget_id");
  });

  test("an allowlist narrows the SET list to exactly its members", async () => {
    await widgetsTable.upsert({ widget_id: "w-1", user_id: "u-1", label: "a" }, ["label"]);
    const columns = updateColumnsOf(emittedSql());
    expect(columns).toContain("label");
    expect(columns).not.toContain("user_id");
  });

  test("an empty allowlist means DO NOTHING, not DO UPDATE", async () => {
    await widgetsTable.upsert({ widget_id: "w-1", user_id: "u-1" }, []);
    expect(emittedSql()).toContain("DO NOTHING");
    expect(emittedSql()).not.toContain("DO UPDATE SET");
  });

  test("an undefined value is dropped from the SET list as well as the INSERT", async () => {
    // The two clauses have to agree: `buildUpsert` skips undefined values when
    // building the INSERT column list, so a SET entry for the same column
    // resolves `EXCLUDED` to the column default and overwrites the stored value
    // with it.
    await widgetsTable.upsert({ widget_id: "w-1", label: "a", note: undefined });
    const sql = emittedSql();
    expect(sql.split("DO UPDATE SET")[0]).not.toContain("note");
    expect(updateColumnsOf(sql)).not.toContain("note");
    expect(updateColumnsOf(sql)).toContain("label");
  });

  test("an allowlist member whose value is undefined is dropped too", async () => {
    await widgetsTable.upsert({ widget_id: "w-1", label: "a", note: undefined }, ["label", "note"]);
    const columns = updateColumnsOf(emittedSql());
    expect(columns).toContain("label");
    expect(columns).not.toContain("note");
  });

  test("an explicit null is a value, so it still overwrites", async () => {
    await widgetsTable.upsert({ widget_id: "w-1", label: "a", note: null });
    expect(updateColumnsOf(emittedSql())).toContain("note");
  });
});
