import { describe, it, expect } from "bun:test";
import {
  SOFT_DELETE_CONDITION,
  IS_NOT_NULL,
  prepareParamValue,
  prepareQuery,
  buildInsert,
  buildUpdate,
  buildUpsert,
  buildSoftDelete,
  buildSelect,
  buildSelectWithFilters,
  buildCreateTable,
  buildCreateIndex,
  successResult,
  errorResult,
  noChangeResult,
} from "./database";

// These are the pure SQL-generation primitives every repository is built on:
// `Table.update` → buildUpdate, `Table.upsert` → buildUpsert, `searchSnapshots`
// /`searchTransactions` → buildSelectWithFilters, etc. A bug in the shared
// param-index arithmetic here corrupts every caller silently, so the contract
// is locked down at the unit level rather than left to integration coverage.

describe("prepareParamValue", () => {
  it("converts Date to an ISO string", () => {
    const d = new Date("2026-01-15T12:34:56.000Z");
    expect(prepareParamValue(d)).toBe("2026-01-15T12:34:56.000Z");
  });

  it("passes through non-Date values unchanged", () => {
    expect(prepareParamValue("abc")).toBe("abc");
    expect(prepareParamValue(42)).toBe(42);
    expect(prepareParamValue(null)).toBe(null);
    expect(prepareParamValue(undefined)).toBe(undefined);
    const arr = ["a", "b"];
    expect(prepareParamValue(arr)).toBe(arr);
  });
});

describe("prepareQuery", () => {
  it("renders equality conditions with parameter placeholders and excludes deleted by default", () => {
    const { sql, values } = prepareQuery({ user_id: "u1", account_id: "a1" });
    expect(sql).toBe(
      `WHERE user_id = $1 AND account_id = $2 AND ${SOFT_DELETE_CONDITION}`,
    );
    expect(values).toEqual(["u1", "a1"]);
  });

  it("renders IS NULL for null and IS NOT NULL for the sentinel without consuming a param", () => {
    const { sql, values } = prepareQuery({ a: null, b: IS_NOT_NULL, c: "x" });
    expect(sql).toBe(
      `WHERE a IS NULL AND b IS NOT NULL AND c = $1 AND ${SOFT_DELETE_CONDITION}`,
    );
    expect(values).toEqual(["x"]);
  });

  it("skips undefined values entirely", () => {
    const { sql, values } = prepareQuery(
      { a: undefined, b: "y" },
      { excludeDeleted: false },
    );
    expect(sql).toBe("WHERE b = $1");
    expect(values).toEqual(["y"]);
  });

  it("honors startIndex so it can be appended to an existing parameter list", () => {
    const { sql, values } = prepareQuery(
      { a: "x" },
      { startIndex: 4, excludeDeleted: false },
    );
    expect(sql).toBe("WHERE a = $4");
    expect(values).toEqual(["x"]);
  });

  it("prepends additional conditions before the data conditions", () => {
    const { sql } = prepareQuery(
      { a: "x" },
      { conditions: ["t.date > NOW()"], excludeDeleted: false },
    );
    expect(sql).toBe("WHERE t.date > NOW() AND a = $1");
  });

  it("returns an empty WHERE clause when there are no conditions", () => {
    const { sql, values } = prepareQuery({}, { excludeDeleted: false });
    expect(sql).toBe("");
    expect(values).toEqual([]);
  });

  it("converts a Date value to an ISO param", () => {
    const { values } = prepareQuery(
      { date: new Date("2026-03-01T00:00:00.000Z") },
      { excludeDeleted: false },
    );
    expect(values).toEqual(["2026-03-01T00:00:00.000Z"]);
  });
});

describe("buildInsert", () => {
  it("always sets updated and numbers data params starting at $1", () => {
    const { sql, values } = buildInsert("transactions", {
      id: "t1",
      amount: 10,
    });
    expect(sql).toBe(
      "INSERT INTO transactions (updated, id, amount) VALUES (CURRENT_TIMESTAMP, $1, $2)",
    );
    expect(values).toEqual(["t1", 10]);
  });

  it("skips undefined columns", () => {
    const { sql, values } = buildInsert("transactions", {
      id: "t1",
      note: undefined,
    });
    expect(sql).toBe(
      "INSERT INTO transactions (updated, id) VALUES (CURRENT_TIMESTAMP, $1)",
    );
    expect(values).toEqual(["t1"]);
  });

  it("appends a RETURNING clause when columns are requested", () => {
    const { sql } = buildInsert("transactions", { id: "t1" }, [
      "id",
      "updated",
    ]);
    expect(sql).toBe(
      "INSERT INTO transactions (updated, id) VALUES (CURRENT_TIMESTAMP, $1) RETURNING id, updated",
    );
  });
});

describe("buildUpdate", () => {
  it("sets updated, numbers data params, and binds the primary key last", () => {
    const q = buildUpdate("transactions", "id", "t1", {
      amount: 10,
      note: "x",
    });
    expect(q).not.toBeNull();
    expect(q!.sql).toBe(
      "UPDATE transactions SET updated = CURRENT_TIMESTAMP, amount = $1, note = $2 WHERE id = $3",
    );
    expect(q!.values).toEqual([10, "x", "t1"]);
  });

  it("returns null when there is nothing to update beyond the timestamp", () => {
    expect(
      buildUpdate("transactions", "id", "t1", { note: undefined }),
    ).toBeNull();
  });

  it("ignores the reserved `raw` key", () => {
    const q = buildUpdate("transactions", "id", "t1", {
      raw: "anything",
      amount: 5,
    });
    expect(q!.sql).toBe(
      "UPDATE transactions SET updated = CURRENT_TIMESTAMP, amount = $1 WHERE id = $2",
    );
    expect(q!.values).toEqual([5, "t1"]);
  });

  it("appends an equality additionalWhere with the correct next param index", () => {
    const q = buildUpdate(
      "transactions",
      "id",
      "t1",
      { amount: 5 },
      {
        additionalWhere: { column: "label_category_confidence", value: 1 },
      },
    );
    expect(q!.sql).toBe(
      "UPDATE transactions SET updated = CURRENT_TIMESTAMP, amount = $1 WHERE id = $2 AND label_category_confidence = $3",
    );
    expect(q!.values).toEqual([5, "t1", 1]);
  });

  it("renders IS NULL / IS NOT NULL additionalWhere without consuming params", () => {
    const q = buildUpdate(
      "transactions",
      "id",
      "t1",
      { amount: 5 },
      {
        additionalWhere: [
          { column: "label_category_id", value: null },
          { column: "merchant_name", value: IS_NOT_NULL },
        ],
      },
    );
    expect(q!.sql).toBe(
      "UPDATE transactions SET updated = CURRENT_TIMESTAMP, amount = $1 WHERE id = $2 AND label_category_id IS NULL AND merchant_name IS NOT NULL",
    );
    expect(q!.values).toEqual([5, "t1"]);
  });

  it("appends a RETURNING clause", () => {
    const q = buildUpdate(
      "transactions",
      "id",
      "t1",
      { amount: 5 },
      { returning: ["id"] },
    );
    expect(q!.sql.endsWith("RETURNING id")).toBe(true);
  });
});

describe("buildUpsert", () => {
  it("emits DO NOTHING when no update columns are given", () => {
    const { sql, values } = buildUpsert("accounts", "id", {
      id: "a1",
      name: "Checking",
    });
    expect(sql).toBe(
      "INSERT INTO accounts (updated, id, name) VALUES (CURRENT_TIMESTAMP, $1, $2)" +
        " ON CONFLICT (id) DO NOTHING RETURNING id",
    );
    expect(values).toEqual(["a1", "Checking"]);
  });

  it("emits DO UPDATE SET, drops the primary key from the update list, and always bumps updated", () => {
    const { sql } = buildUpsert(
      "accounts",
      "id",
      { id: "a1", name: "Checking", balance: 100 },
      { updateColumns: ["id", "name", "balance"] },
    );
    expect(sql).toContain(
      "ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, balance = EXCLUDED.balance, updated = CURRENT_TIMESTAMP",
    );
    expect(sql).not.toContain("id = EXCLUDED.id");
  });

  it("uses a custom RETURNING list", () => {
    const { sql } = buildUpsert(
      "accounts",
      "id",
      { id: "a1" },
      { returning: ["id", "updated"] },
    );
    expect(sql.endsWith("RETURNING id, updated")).toBe(true);
  });
});

describe("buildSoftDelete", () => {
  it("flags is_deleted and returns the primary key", () => {
    const { sql, values } = buildSoftDelete("transactions", "id", "t1");
    expect(sql).toBe(
      "UPDATE transactions SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id",
    );
    expect(values).toEqual(["t1"]);
  });

  it("ANDs an additionalWhere as $2", () => {
    const { sql, values } = buildSoftDelete("transactions", "id", "t1", {
      column: "user_id",
      value: "u1",
    });
    expect(sql).toBe(
      "UPDATE transactions SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2 RETURNING id",
    );
    expect(values).toEqual(["t1", "u1"]);
  });
});

describe("buildSelect", () => {
  it("selects * and threads a where clause's values", () => {
    const where = prepareQuery({ a: 1 }, { excludeDeleted: false });
    const { sql, values } = buildSelect("widgets", "*", where);
    expect(sql).toBe("SELECT * FROM widgets WHERE a = $1");
    expect(values).toEqual([1]);
  });

  it("continues placeholder numbering for LIMIT and OFFSET after where values", () => {
    const where = prepareQuery({ a: 1 }, { excludeDeleted: false });
    const { sql, values } = buildSelect("widgets", ["id", "name"], where, "name ASC", 10, 20);
    expect(sql).toBe(
      "SELECT id, name FROM widgets WHERE a = $1 ORDER BY name ASC LIMIT $2 OFFSET $3",
    );
    expect(values).toEqual([1, 10, 20]);
  });

  it("works with no where clause", () => {
    const { sql, values } = buildSelect("widgets", "*");
    expect(sql).toBe("SELECT * FROM widgets");
    expect(values).toEqual([]);
  });
});

describe("buildSelectWithFilters", () => {
  it("returns a bare SELECT with the soft-delete guard when no filters are passed", () => {
    const { sql, values } = buildSelectWithFilters("transactions", "*");
    expect(sql).toBe(
      `SELECT * FROM transactions WHERE ${SOFT_DELETE_CONDITION}`,
    );
    expect(values).toEqual([]);
  });

  it("joins explicit columns instead of *", () => {
    const { sql } = buildSelectWithFilters("transactions", ["id", "amount"], {
      excludeDeleted: false,
    });
    expect(sql).toBe("SELECT id, amount FROM transactions");
  });

  it("numbers user_id, primaryKey, eq filters, IN filters, and date range in a single ascending sequence", () => {
    const { sql, values } = buildSelectWithFilters("transactions", "*", {
      user_id: "u1",
      primaryKey: { column: "id", value: "t1" },
      filters: {
        account_id: "a1",
        label_category_id: null,
        merchant_name: IS_NOT_NULL,
      },
      inFilters: { category_id: ["c1", "c2"] },
      dateRange: { column: "date", start: "2026-01-01", end: "2026-02-01" },
      excludeDeleted: true,
    });
    expect(sql).toBe(
      "SELECT * FROM transactions WHERE user_id = $1 AND id = $2 AND account_id = $3" +
        " AND label_category_id IS NULL AND merchant_name IS NOT NULL" +
        " AND category_id IN ($4, $5) AND date >= $6 AND date <= $7" +
        ` AND ${SOFT_DELETE_CONDITION}`,
    );
    expect(values).toEqual([
      "u1",
      "t1",
      "a1",
      "c1",
      "c2",
      "2026-01-01",
      "2026-02-01",
    ]);
  });

  it("skips empty IN filters without consuming a param index", () => {
    const { sql, values } = buildSelectWithFilters("transactions", "*", {
      inFilters: { category_id: [] },
      filters: { account_id: "a1" },
      excludeDeleted: false,
    });
    expect(sql).toBe("SELECT * FROM transactions WHERE account_id = $1");
    expect(values).toEqual(["a1"]);
  });

  it("converts Date range bounds to date-only strings", () => {
    const { values } = buildSelectWithFilters("transactions", "*", {
      dateRange: {
        column: "date",
        start: new Date("2026-01-01T08:00:00.000Z"),
        end: new Date("2026-02-01T23:00:00.000Z"),
      },
      excludeDeleted: false,
    });
    expect(values).toEqual(["2026-01-01", "2026-02-01"]);
  });

  it("places ORDER BY, LIMIT, and OFFSET after the WHERE clause with trailing params", () => {
    const { sql, values } = buildSelectWithFilters("transactions", "*", {
      user_id: "u1",
      orderBy: "date DESC",
      limit: 50,
      offset: 100,
      excludeDeleted: false,
    });
    expect(sql).toBe(
      "SELECT * FROM transactions WHERE user_id = $1 ORDER BY date DESC LIMIT $2 OFFSET $3",
    );
    expect(values).toEqual(["u1", 50, 100]);
  });
});

describe("DDL builders", () => {
  it("buildCreateTable joins column definitions and constraints", () => {
    const sql = buildCreateTable(
      "things",
      { id: "TEXT PRIMARY KEY", name: "TEXT" },
      ["UNIQUE (name)"],
    );
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS things (");
    expect(sql).toContain("id TEXT PRIMARY KEY");
    expect(sql).toContain("name TEXT");
    expect(sql).toContain("UNIQUE (name)");
  });

  it("buildCreateIndex derives a default name and honors an override", () => {
    expect(buildCreateIndex("things", "name")).toBe(
      "CREATE INDEX IF NOT EXISTS idx_things_name ON things(name)",
    );
    expect(buildCreateIndex("things", "name", "custom_idx")).toBe(
      "CREATE INDEX IF NOT EXISTS custom_idx ON things(name)",
    );
  });
});

describe("result helpers", () => {
  it("successResult maps a non-zero rowCount to 200 and zero/null to 404", () => {
    expect(successResult("x", 1)).toEqual({
      update: { _id: "x" },
      status: 200,
    });
    expect(successResult("x", 0)).toEqual({
      update: { _id: "x" },
      status: 404,
    });
    expect(successResult("x", null)).toEqual({
      update: { _id: "x" },
      status: 404,
    });
  });

  it("errorResult is 500 and noChangeResult is 304", () => {
    expect(errorResult("x")).toEqual({ update: { _id: "x" }, status: 500 });
    expect(noChangeResult("x")).toEqual({ update: { _id: "x" }, status: 304 });
  });
});
