// Behavior pins for the Table model surface in ./base that the existing
// base.test.ts does not cover. base.test.ts pins upsert/upsertMany/
// queryInBatches; this file pins everything else a migration (pg -> Bun's
// native SQL client) must preserve:
//
// - the exact SQL + values each method issues (the SQL contract the new
//   driver must reproduce, whatever its placeholder syntax),
// - result mapping (rows -> model instances, rowCount -> boolean/count,
//   empty results -> null/[]/0/false),
// - the composite-primary-key guard: which methods throw, with what
//   message, and — deliberately — that query/queryOne do NOT throw,
// - client routing: methods that accept a QueryExecutor must use it,
//   never the pool (a dropped client argument would commit outside the
//   caller's transaction and survive its rollback),
// - error propagation: a pool.query rejection reaches the caller
//   unchanged — no production code maps pg error codes.
//
// CI has no Postgres service, so these run against the shared createFakeSql
// stub (see scripts/test-helpers.ts). The SQL strings are produced by the
// repo's own builders, not by the stub; the stub only returns scripted
// rows, which is what makes the mapping assertions meaningful.
import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";
import { IS_NOT_NULL } from "../database";

const { driver, mockUnsafe, mockReservedUnsafe, resetSqlMocks } = createFakeSql();

mock.module("../sql-driver", () => driver);

const { createTable } = await import("./base");

afterAll(restoreLeaves);

beforeEach(() => {
  resetSqlMocks();
});

class WidgetModel {
  widget_id!: string;
  user_id!: string;
  label!: string;
  note!: string | null;
  constructor(row: Record<string, unknown>) {
    Object.assign(this, row);
  }
}

const widgetsTable = createTable({
  name: "widgets",
  primaryKey: "widget_id",
  schema: {
    widget_id: "VARCHAR(255) PRIMARY KEY",
    user_id: "VARCHAR(255)",
    label: "VARCHAR(255)",
    note: "VARCHAR(255)",
  },
  ModelClass: WidgetModel as never,
});

const compositeTable = createTable({
  name: "widgets",
  primaryKey: "widget_id",
  schema: {
    widget_id: "VARCHAR(255)",
    user_id: "VARCHAR(255)",
  },
  constraints: ["PRIMARY KEY (widget_id, user_id)"],
  ModelClass: WidgetModel as never,
});

const namedCompositeTable = createTable({
  name: "widgets",
  primaryKey: "widget_id",
  schema: {
    widget_id: "VARCHAR(255)",
    user_id: "VARCHAR(255)",
  },
  constraints: ["CONSTRAINT pk_widgets PRIMARY KEY (widget_id, user_id)"],
  ModelClass: WidgetModel as never,
});

const guardMessage = (method: string) =>
  `Table.${method}() is not supported on 'widgets' — composite PRIMARY KEY tables must use raw pool.query writes in their repository layer.`;

const row = (overrides: Record<string, unknown> = {}) => ({
  widget_id: "w-1",
  user_id: "u-1",
  label: "a",
  note: null,
  ...overrides,
});

const lastCall = () => {
  const [sql, values] = mockUnsafe.mock.calls.at(-1) as [string, unknown[]];
  return { sql, values };
};

describe("Table.query", () => {
  test("equality filter + soft-delete predicate, rows mapped to models", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [row()], rowCount: 1 });
    const out = await widgetsTable.query({ user_id: "u-1" });
    expect(out).toHaveLength(1);
    expect(out[0]).toBeInstanceOf(WidgetModel);
    expect(out[0].label).toBe("a");
    expect(lastCall().sql).toBe(
      "SELECT * FROM widgets WHERE user_id = $1 AND (is_deleted IS NULL OR is_deleted = FALSE)",
    );
    expect(lastCall().values).toEqual(["u-1"]);
  });

  test("null filter becomes IS NULL with no value", async () => {
    await widgetsTable.query({ label: null });
    expect(lastCall().sql).toBe(
      "SELECT * FROM widgets WHERE label IS NULL AND (is_deleted IS NULL OR is_deleted = FALSE)",
    );
    expect(lastCall().values).toEqual([]);
  });

  test("IS_NOT_NULL filter becomes IS NOT NULL with no value", async () => {
    await widgetsTable.query({ label: IS_NOT_NULL });
    expect(lastCall().sql).toBe(
      "SELECT * FROM widgets WHERE label IS NOT NULL AND (is_deleted IS NULL OR is_deleted = FALSE)",
    );
    expect(lastCall().values).toEqual([]);
  });

  test("undefined filter is skipped entirely", async () => {
    await widgetsTable.query({ label: undefined });
    expect(lastCall().sql).toBe(
      "SELECT * FROM widgets WHERE (is_deleted IS NULL OR is_deleted = FALSE)",
    );
    expect(lastCall().values).toEqual([]);
  });

  test("user_id option, IN filter, order, limit and offset share one numbering", async () => {
    await widgetsTable.query(
      {},
      {
        user_id: "u-1",
        inFilters: { widget_id: ["w-1", "w-2"] },
        orderBy: "label",
        limit: 10,
        offset: 20,
      },
    );
    expect(lastCall().sql).toBe(
      "SELECT * FROM widgets WHERE user_id = $1 AND widget_id IN ($2, $3) AND (is_deleted IS NULL OR is_deleted = FALSE) ORDER BY label LIMIT $4 OFFSET $5",
    );
    expect(lastCall().values).toEqual(["u-1", "w-1", "w-2", 10, 20]);
  });

  test("primaryKey option filters on the key column", async () => {
    await widgetsTable.query({}, { primaryKey: { column: "widget_id", value: "w-1" } });
    expect(lastCall().sql).toBe(
      "SELECT * FROM widgets WHERE widget_id = $1 AND (is_deleted IS NULL OR is_deleted = FALSE)",
    );
    expect(lastCall().values).toEqual(["w-1"]);
  });

  test("dateRange converts Date bounds to date strings", async () => {
    await widgetsTable.query(
      {},
      {
        dateRange: {
          column: "created_at",
          start: new Date("2026-01-05T00:00:00.000Z"),
          end: "2026-02-01",
        },
      },
    );
    expect(lastCall().sql).toBe(
      "SELECT * FROM widgets WHERE created_at >= $1 AND created_at <= $2 AND (is_deleted IS NULL OR is_deleted = FALSE)",
    );
    expect(lastCall().values).toEqual(["2026-01-05", "2026-02-01"]);
  });

  test("after keyset pagination appends after the soft-delete predicate", async () => {
    await widgetsTable.query({}, { after: { column: "widget_id", value: "w-9" } });
    expect(lastCall().sql).toBe(
      "SELECT * FROM widgets WHERE (is_deleted IS NULL OR is_deleted = FALSE) AND widget_id > $1",
    );
    expect(lastCall().values).toEqual(["w-9"]);
  });

  test("excludeDeleted: false drops the soft-delete predicate entirely", async () => {
    await widgetsTable.query({}, { excludeDeleted: false });
    expect(lastCall().sql).toBe("SELECT * FROM widgets");
    expect(lastCall().values).toEqual([]);
  });

  test("empty result maps to []", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await widgetsTable.query({ user_id: "u-1" })).toEqual([]);
  });

  test("a pool rejection propagates unchanged", async () => {
    const boom = new Error("boom");
    mockUnsafe.mockRejectedValueOnce(boom);
    await expect(widgetsTable.query({ user_id: "u-1" })).rejects.toBe(boom);
  });

  test("an explicit client is used instead of the pool", async () => {
    const client = { query: mockReservedUnsafe };
    mockReservedUnsafe.mockResolvedValueOnce({ rows: [row()], rowCount: 1 });
    const out = await widgetsTable.query({ user_id: "u-1" }, {}, client as never);
    expect(out).toHaveLength(1);
    expect(mockReservedUnsafe).toHaveBeenCalledTimes(1);
    expect(mockUnsafe).not.toHaveBeenCalled();
  });
});

describe("Table.queryOne", () => {
  test("appends LIMIT 1, returns the first row or null", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [row()], rowCount: 1 });
    const found = await widgetsTable.queryOne({ user_id: "u-1" });
    expect(found).toBeInstanceOf(WidgetModel);
    expect(lastCall().sql).toBe(
      "SELECT * FROM widgets WHERE user_id = $1 AND (is_deleted IS NULL OR is_deleted = FALSE) LIMIT $2",
    );
    expect(lastCall().values).toEqual(["u-1", 1]);

    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await widgetsTable.queryOne({ user_id: "u-1" })).toBeNull();
  });
});

describe("Table.insert", () => {
  test("updated is CURRENT_TIMESTAMP first; undefined fields drop out; RETURNING pk", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [row()], rowCount: 1 });
    const out = await widgetsTable.insert({ widget_id: "w-1", user_id: "u-1", note: undefined });
    expect(out).toEqual(row());
    expect(lastCall().sql).toBe(
      "INSERT INTO widgets (updated, widget_id, user_id) VALUES (CURRENT_TIMESTAMP, $1, $2) RETURNING widget_id",
    );
    expect(lastCall().values).toEqual(["w-1", "u-1"]);
  });

  test("an explicit returning list replaces the pk default", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [row()], rowCount: 1 });
    await widgetsTable.insert({ widget_id: "w-1", user_id: "u-1" }, ["widget_id", "label"]);
    expect(lastCall().sql).toBe(
      "INSERT INTO widgets (updated, widget_id, user_id) VALUES (CURRENT_TIMESTAMP, $1, $2) RETURNING widget_id, label",
    );
  });

  test("no returned row maps to null", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await widgetsTable.insert({ widget_id: "w-1" })).toBeNull();
  });
});

describe("Table.update", () => {
  test("SET + pk + user guard + null guard + soft-delete predicate, in order", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [row()], rowCount: 1 });
    const out = await widgetsTable.update(
      "w-1",
      { label: "b" },
      ["widget_id"],
      "u-1",
      undefined,
      [{ column: "note", value: null }],
      true,
    );
    expect(out).toEqual(row());
    expect(lastCall().sql).toBe(
      "UPDATE widgets SET updated = CURRENT_TIMESTAMP, label = $1 WHERE widget_id = $2 AND user_id = $3 AND note IS NULL AND (is_deleted IS NULL OR is_deleted = FALSE) RETURNING widget_id",
    );
    expect(lastCall().values).toEqual(["b", "w-1", "u-1"]);
  });

  test("no settable fields returns null WITHOUT issuing a query", async () => {
    expect(await widgetsTable.update("w-1", {})).toBeNull();
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("no returned row maps to null", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await widgetsTable.update("w-1", { label: "b" })).toBeNull();
  });

  test("an explicit client is used instead of the pool", async () => {
    const client = { query: mockReservedUnsafe };
    mockReservedUnsafe.mockResolvedValueOnce({ rows: [row()], rowCount: 1 });
    await widgetsTable.update("w-1", { label: "b" }, ["widget_id"], undefined, client as never);
    expect(mockReservedUnsafe).toHaveBeenCalledTimes(1);
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("upsert and bulkSoftDelete route through an explicit client too", async () => {
    const client = { query: mockReservedUnsafe };
    mockReservedUnsafe.mockResolvedValueOnce({ rows: [row()], rowCount: 1 });
    await widgetsTable.upsert({ widget_id: "w-1", user_id: "u-1" }, undefined, client as never);
    mockReservedUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await widgetsTable.bulkSoftDelete(["w-1"], undefined, client as never);
    expect(mockReservedUnsafe).toHaveBeenCalledTimes(2);
    expect(mockUnsafe).not.toHaveBeenCalled();
  });
});

describe("Table deletes", () => {
  test("softDelete sets is_deleted + updated, returns rowCount > 0", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [{ widget_id: "w-1" }], rowCount: 1 });
    expect(await widgetsTable.softDelete("w-1")).toBe(true);
    expect(lastCall().sql).toBe(
      "UPDATE widgets SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE widget_id = $1 RETURNING widget_id",
    );
    expect(lastCall().values).toEqual(["w-1"]);

    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await widgetsTable.softDelete("w-1")).toBe(false);

    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: null });
    expect(await widgetsTable.softDelete("w-1")).toBe(false);
  });

  test("softDelete with a userId scopes on user_id", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [{ widget_id: "w-1" }], rowCount: 1 });
    await widgetsTable.softDelete("w-1", "u-1");
    expect(lastCall().sql).toBe(
      "UPDATE widgets SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE widget_id = $1 AND user_id = $2 RETURNING widget_id",
    );
    expect(lastCall().values).toEqual(["w-1", "u-1"]);
  });

  test("queryByIds: empty list short-circuits with no query", async () => {
    expect(await widgetsTable.queryByIds([])).toEqual([]);
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("queryByIds numbers IN placeholders and appends filters after the soft-delete predicate", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [row()], rowCount: 1 });
    const out = await widgetsTable.queryByIds(["w-1", "w-2"], { label: "a" });
    expect(out).toHaveLength(1);
    expect(lastCall().sql).toBe(
      "SELECT * FROM widgets WHERE widget_id IN ($1, $2) AND (is_deleted IS NULL OR is_deleted = FALSE) AND label = $3",
    );
    expect(lastCall().values).toEqual(["w-1", "w-2", "a"]);
  });

  test("bulkSoftDelete: empty list short-circuits; otherwise rowCount, null -> 0", async () => {
    expect(await widgetsTable.bulkSoftDelete([])).toBe(0);
    expect(mockUnsafe).not.toHaveBeenCalled();

    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 2 });
    expect(await widgetsTable.bulkSoftDelete(["w-1", "w-2"])).toBe(2);
    expect(lastCall().sql).toBe(
      "UPDATE widgets SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE widget_id IN ($1, $2) RETURNING widget_id",
    );

    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: null });
    expect(await widgetsTable.bulkSoftDelete(["w-1"])).toBe(0);
  });

  test("bulkSoftDeleteByColumn: single value uses =, an array uses ANY($1)", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await widgetsTable.bulkSoftDeleteByColumn("label", "a");
    expect(lastCall().sql).toBe(
      "UPDATE widgets SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE label = $1 RETURNING widget_id",
    );
    expect(lastCall().values).toEqual(["a"]);

    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 2 });
    await widgetsTable.bulkSoftDeleteByColumn("label", ["a", "b"], "u-1");
    expect(lastCall().sql).toBe(
      "UPDATE widgets SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE label = ANY($1) AND user_id = $2 RETURNING widget_id",
    );
    expect(lastCall().values).toEqual([["a", "b"], "u-1"]);

    expect(await widgetsTable.bulkSoftDeleteByColumn("label", [])).toBe(0);
  });

  test("bulkSoftDeleteByRelatedColumn resolves the match inside a subquery", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 3 });
    expect(
      await widgetsTable.bulkSoftDeleteByRelatedColumn(
        "user_id",
        {
          table: "users",
          selectColumn: "user_id",
          matchColumn: "account_id",
          matchValues: ["a1", "a2"],
        },
        "u-1",
      ),
    ).toBe(3);
    expect(lastCall().sql).toBe(
      "UPDATE widgets SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE user_id IN (SELECT user_id FROM users WHERE account_id = ANY($1)) AND user_id = $2 RETURNING widget_id",
    );
    expect(lastCall().values).toEqual([["a1", "a2"], "u-1"]);

    expect(
      await widgetsTable.bulkSoftDeleteByRelatedColumn("user_id", {
        table: "users",
        selectColumn: "user_id",
        matchColumn: "account_id",
        matchValues: [],
      }),
    ).toBe(0);
  });

  test("hardDelete / bulkHardDelete / hardDeleteByColumn / deleteByCondition", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [{ widget_id: "w-1" }], rowCount: 1 });
    expect(await widgetsTable.hardDelete("w-1")).toBe(true);
    expect(lastCall().sql).toBe(
      "DELETE FROM widgets WHERE widget_id = $1 RETURNING widget_id",
    );

    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await widgetsTable.hardDelete("w-1")).toBe(false);

    expect(await widgetsTable.bulkHardDelete([])).toBe(0);
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 2 });
    expect(await widgetsTable.bulkHardDelete(["w-1", "w-2"])).toBe(2);
    expect(lastCall().sql).toBe(
      "DELETE FROM widgets WHERE widget_id IN ($1, $2) RETURNING widget_id",
    );

    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    expect(await widgetsTable.hardDeleteByColumn("label", "a")).toBe(1);
    expect(lastCall().sql).toBe(
      "DELETE FROM widgets WHERE label = $1 RETURNING widget_id",
    );

    for (const op of ["=", "<=", ">=", "<", ">", "!="] as const) {
      mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      expect(await widgetsTable.deleteByCondition("label", op, "a")).toBe(1);
      expect(lastCall().sql).toBe(
        `DELETE FROM widgets WHERE label ${op} $1 RETURNING widget_id`,
      );
    }
  });
});

describe("composite-primary-key guard", () => {
  // Every mutating / batch method refuses composite-PK tables so a caller
  // can't silently match on the wrong constraint; repositories use raw
  // pool.query instead. query/queryOne deliberately have NO guard — they
  // only read — and that asymmetry is pinned below too.
  const cases: Array<[string, () => Promise<unknown>]> = [
    ["insert", () => compositeTable.insert({ widget_id: "w-1" })],
    ["update", () => compositeTable.update("w-1", { label: "x" })],
    ["upsert", () => compositeTable.upsert({ widget_id: "w-1" })],
    ["upsertMany", () => compositeTable.upsertMany([{ widget_id: "w-1" }])],
    ["softDelete", () => compositeTable.softDelete("w-1")],
    ["queryByIds", () => compositeTable.queryByIds(["w-1"])],
    ["bulkSoftDelete", () => compositeTable.bulkSoftDelete(["w-1"])],
    ["bulkSoftDeleteByColumn", () => compositeTable.bulkSoftDeleteByColumn("label", "a")],
    [
      "bulkSoftDeleteByRelatedColumn",
      () =>
        compositeTable.bulkSoftDeleteByRelatedColumn("user_id", {
          table: "users",
          selectColumn: "user_id",
          matchColumn: "account_id",
          matchValues: ["a1"],
        }),
    ],
    ["hardDelete", () => compositeTable.hardDelete("w-1")],
    ["bulkHardDelete", () => compositeTable.bulkHardDelete(["w-1"])],
    ["hardDeleteByColumn", () => compositeTable.hardDeleteByColumn("label", "a")],
    ["deleteByCondition", () => compositeTable.deleteByCondition("label", "=", "a")],
  ];

  test.each(cases)("%s throws on a composite-PK table without issuing a query", async (method, run) => {
    await expect(run()).rejects.toThrow(guardMessage(method));
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockReservedUnsafe).not.toHaveBeenCalled();
  });

  test("the named-constraint spelling guards the same way", async () => {
    await expect(namedCompositeTable.insert({ widget_id: "w-1" })).rejects.toThrow(
      guardMessage("insert"),
    );
    await expect(namedCompositeTable.softDelete("w-1")).rejects.toThrow(
      guardMessage("softDelete"),
    );
  });

  test("queryInBatches throws when iteration starts, before any query", async () => {
    const gen = compositeTable.queryInBatches({}, {});
    await expect(gen.next()).rejects.toThrow(guardMessage("queryInBatches"));
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("query and queryOne deliberately do NOT guard — reads are safe", async () => {
    mockUnsafe.mockResolvedValueOnce({ rows: [row()], rowCount: 1 });
    expect(await compositeTable.query({ user_id: "u-1" })).toHaveLength(1);
    mockUnsafe.mockResolvedValueOnce({ rows: [row()], rowCount: 1 });
    expect(await compositeTable.queryOne({ user_id: "u-1" })).toBeInstanceOf(WidgetModel);
  });
});

describe("database.query / queryOne pass-through", () => {
  test("query returns the pool result untouched; queryOne returns the first row or null", async () => {
    const { query, queryOne } = await import("../database");
    const fakePool = { query: mockUnsafe } as never;
    mockUnsafe.mockResolvedValueOnce({ rows: [row()], rowCount: 1 });
    const result = await query(fakePool, "SELECT 1", ["a"]);
    expect(result.rows).toEqual([row()]);
    expect(mockUnsafe.mock.calls[0]).toEqual(["SELECT 1", ["a"]]);

    mockUnsafe.mockResolvedValueOnce({ rows: [row()], rowCount: 1 });
    expect(await queryOne(fakePool, "SELECT 1")).toEqual(row());
    mockUnsafe.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await queryOne(fakePool, "SELECT 1")).toBeNull();
  });
});
