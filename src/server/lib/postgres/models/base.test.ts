import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakePg, restoreLeaves, updateColumnsOf } from "test-helpers";

const { pg, mockQuery, clearQueryMocks } = createFakePg();

mock.module("pg", () => pg);

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
  clearQueryMocks();
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

describe("Table.upsertMany", () => {
  test("a repeated primary key collapses to one tuple, last write winning", async () => {
    // Postgres rejects a statement whose `ON CONFLICT DO UPDATE` would touch the
    // same row twice (21000), so a caller handing over two rows for one id —
    // a SimpleFin item with two accounts at one organization does exactly that —
    // has to arrive as a single tuple, not two.
    await widgetsTable.upsertMany([
      { widget_id: "w-1", label: "first" },
      { widget_id: "w-1", label: "second" },
    ]);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][1]).toEqual(["w-1", "second"]);
  });

  test("rows are grouped by defined-column set, one statement per group", async () => {
    // A column present in one row and absent from another would insert as its
    // default and then be propagated by `EXCLUDED.col` over the stored value.
    await widgetsTable.upsertMany([
      { widget_id: "w-1", label: "a", note: "keep" },
      { widget_id: "w-2", label: "b" },
    ]);
    expect(mockQuery).toHaveBeenCalledTimes(2);

    const [withNote, withoutNote] = mockQuery.mock.calls.map((call) => call[0] as string);
    expect(updateColumnsOf(withNote)).toContain("note");
    expect(updateColumnsOf(withNote)).toContain("label");
    expect(mockQuery.mock.calls[0][1]).toEqual(["w-1", "a", "keep"]);

    expect(withoutNote).not.toContain("note");
    expect(updateColumnsOf(withoutNote)).toContain("label");
    expect(mockQuery.mock.calls[1][1]).toEqual(["w-2", "b"]);
  });
});

describe("Table.queryInBatches", () => {
  class WidgetModel {
    widget_id: string;
    constructor(row: { widget_id: string }) {
      this.widget_id = row.widget_id;
    }
  }
  const pagedWidgetsTable = createTable({
    name: "widgets",
    primaryKey: "widget_id",
    schema: { widget_id: "VARCHAR(255) PRIMARY KEY", user_id: "VARCHAR(255)" },
    ModelClass: WidgetModel as never,
  });
  const row = (n: number) => ({ widget_id: `w-${String(n).padStart(3, "0")}`, user_id: "u-1" });
  const rowsFrom = (first: number, count: number) =>
    Array.from({ length: count }, (_, i) => row(first + i));

  const collectIds = async (batchSize: number) => {
    const batches: string[][] = [];
    for await (const models of pagedWidgetsTable.queryInBatches({ user_id: "u-1" }, {}, batchSize)) {
      batches.push(models.map((m) => (m as unknown as WidgetModel).widget_id));
    }
    return batches;
  };

  test("pages by primary key, resuming after the last row of each full batch", async () => {
    mockQuery
      .mockImplementationOnce(async () => ({ rows: rowsFrom(1, 2), rowCount: 2 }))
      .mockImplementationOnce(async () => ({ rows: rowsFrom(3, 2), rowCount: 2 }))
      .mockImplementationOnce(async () => ({ rows: rowsFrom(5, 1), rowCount: 1 }));

    expect(await collectIds(2)).toEqual([["w-001", "w-002"], ["w-003", "w-004"], ["w-005"]]);
    expect(mockQuery).toHaveBeenCalledTimes(3);

    const [firstSql, firstValues] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(firstSql).toContain("ORDER BY widget_id LIMIT $");
    expect(firstSql).not.toContain("widget_id >");
    expect(firstValues).toEqual(["u-1", 2]);

    const [secondSql, secondValues] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(secondSql).toContain("widget_id > $");
    expect(secondValues).toEqual(["u-1", "w-002", 2]);
    expect((mockQuery.mock.calls[2] as [string, unknown[]])[1]).toEqual(["u-1", "w-004", 2]);
  });

  test("a full final batch costs one empty read, then stops", async () => {
    mockQuery
      .mockImplementationOnce(async () => ({ rows: rowsFrom(1, 2), rowCount: 2 }))
      .mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));

    expect(await collectIds(2)).toEqual([["w-001", "w-002"]]);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  test("an empty result yields no batches", async () => {
    mockQuery.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));

    expect(await collectIds(2)).toEqual([]);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test("nothing is queried until iteration starts", () => {
    pagedWidgetsTable.queryInBatches({ user_id: "u-1" }, {}, 2);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
