import { describe, it, expect } from "bun:test";
import {
  SOFT_DELETE_CONDITION,
  IS_NOT_NULL,
  SHARING_USER_IDS,
  SharedWith,
  sharedWith,
  sharedWithSql,
  sharingLockKeySql,
  prepareParamValue,
  prepareQuery,
  buildInsert,
  buildUpdate,
  buildUpsert,
  buildUpsertMany,
  buildSoftDelete,
  buildSelect,
  buildSelectWithFilters,
  buildCreateTable,
  buildCreateIndex,
  buildSelectDuplicateKeys,
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

  it("puts ON CONFLICT DO NOTHING before the RETURNING clause when asked", () => {
    const { sql } = buildInsert("users", { username: "alice" }, ["user_id"], {
      onConflictDoNothing: true,
    });
    expect(sql).toBe(
      "INSERT INTO users (updated, username) VALUES (CURRENT_TIMESTAMP, $1) ON CONFLICT DO NOTHING RETURNING user_id",
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
      "UPDATE transactions SET updated = CURRENT_TIMESTAMP, amount = $1, note = $2 WHERE id = $3 AND (is_deleted IS NULL OR is_deleted = FALSE)",
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
      "UPDATE transactions SET updated = CURRENT_TIMESTAMP, amount = $1 WHERE id = $2 AND (is_deleted IS NULL OR is_deleted = FALSE)",
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
      "UPDATE transactions SET updated = CURRENT_TIMESTAMP, amount = $1 WHERE id = $2 AND label_category_confidence = $3 AND (is_deleted IS NULL OR is_deleted = FALSE)",
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
      "UPDATE transactions SET updated = CURRENT_TIMESTAMP, amount = $1 WHERE id = $2 AND label_category_id IS NULL AND merchant_name IS NOT NULL AND (is_deleted IS NULL OR is_deleted = FALSE)",
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

  it("includes the live-row predicate by default — exclusion is the default, inclusion is opt-in", () => {
    const q = buildUpdate("transactions", "id", "t1", { amount: 5 });
    expect(q!.sql).toContain("is_deleted");
    const optOut = buildUpdate(
      "transactions",
      "id",
      "t1",
      { amount: 5 },
      { excludeDeleted: false },
    );
    expect(optOut!.sql).not.toContain("is_deleted");
  });

  it("appends the live-row predicate for excludeDeleted without consuming a param", () => {
    const q = buildUpdate(
      "transactions",
      "id",
      "t1",
      { amount: 5 },
      { excludeDeleted: true },
    );
    expect(q!.sql).toBe(
      "UPDATE transactions SET updated = CURRENT_TIMESTAMP, amount = $1 WHERE id = $2 AND (is_deleted IS NULL OR is_deleted = FALSE)",
    );
    expect(q!.values).toEqual([5, "t1"]);
  });

  it("orders the live-row predicate after additionalWhere, leaving its numbering intact", () => {
    const q = buildUpdate(
      "transactions",
      "id",
      "t1",
      { amount: 5 },
      { additionalWhere: { column: "user_id", value: "u-1" }, excludeDeleted: true, returning: ["id"] },
    );
    expect(q!.sql).toBe(
      "UPDATE transactions SET updated = CURRENT_TIMESTAMP, amount = $1 WHERE id = $2 AND user_id = $3 AND (is_deleted IS NULL OR is_deleted = FALSE) RETURNING id",
    );
    expect(q!.values).toEqual([5, "t1", "u-1"]);
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

  it("finds the conflicting row by the conflict columns given, and never rewrites them", () => {
    const { sql, values } = buildUpsert(
      "invites",
      "id",
      { owner: "u1", address: "a@b", expires: "2026-12-22" },
      { updateColumns: ["owner", "address", "expires"], conflictColumns: ["owner", "address"] },
    );
    expect(sql).toBe(
      "INSERT INTO invites (updated, owner, address, expires) VALUES (CURRENT_TIMESTAMP, $1, $2, $3)" +
        " ON CONFLICT (owner, address) DO UPDATE SET expires = EXCLUDED.expires, updated = CURRENT_TIMESTAMP" +
        " RETURNING id",
    );
    expect(values).toEqual(["u1", "a@b", "2026-12-22"]);
  });

  it("names the conflict columns in a DO NOTHING too", () => {
    const { sql } = buildUpsert(
      "invites",
      "id",
      { owner: "u1", address: "a@b" },
      { conflictColumns: ["owner", "address"] },
    );
    expect(sql).toContain(" ON CONFLICT (owner, address) DO NOTHING");
  });
});

describe("buildUpsertMany", () => {
  it("emits one statement carrying a tuple per row", () => {
    const query = buildUpsertMany(
      "accounts",
      "id",
      [
        { id: "a1", name: "Checking" },
        { id: "a2", name: "Savings" },
      ],
      { updateColumns: ["name"] },
    );
    expect(query!.sql).toBe(
      "INSERT INTO accounts (updated, id, name) VALUES" +
        " (CURRENT_TIMESTAMP, $1, $2), (CURRENT_TIMESTAMP, $3, $4)" +
        " ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated = CURRENT_TIMESTAMP" +
        " RETURNING id",
    );
    expect(query!.values).toEqual(["a1", "Checking", "a2", "Savings"]);
  });

  it("returns null for an empty row list", () => {
    expect(buildUpsertMany("accounts", "id", [])).toBe(null);
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

  it("matches equalsIgnoringCase by lowering both sides, numbered between the IN filters and the date range", () => {
    const { sql, values } = buildSelectWithFilters("users", "*", {
      filters: { auth_sub: null, username: "alice" },
      inFilters: { user_id: ["u1"] },
      equalsIgnoringCase: { column: "email", value: "Alice@Example.com" },
      dateRange: { column: "updated", start: "2026-01-01" },
      limit: 1,
    });
    expect(sql).toBe(
      "SELECT * FROM users WHERE auth_sub IS NULL AND username = $1 AND user_id IN ($2)" +
        " AND lower(email) = lower($3) AND updated >= $4" +
        ` AND ${SOFT_DELETE_CONDITION} LIMIT $5`,
    );
    expect(values).toEqual(["alice", "u1", "Alice@Example.com", "2026-01-01", 1]);
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

  it("adds a keyset bound after the other conditions, ahead of ORDER BY and LIMIT", () => {
    const { sql, values } = buildSelectWithFilters("transactions", "*", {
      user_id: "u1",
      after: { column: "transaction_id", value: "t-500" },
      orderBy: "transaction_id",
      limit: 500,
      excludeDeleted: true,
    });
    expect(sql).toBe(
      `SELECT * FROM transactions WHERE user_id = $1 AND ${SOFT_DELETE_CONDITION}` +
        " AND transaction_id > $2 ORDER BY transaction_id LIMIT $3",
    );
    expect(values).toEqual(["u1", "t-500", 500]);
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

// `sharedWith(user)` in an owner slot widens `<column> = $N` to the user's
// sharing group. Every builder that takes an equality value has its own copy of
// the branch, so each is pinned with a neighbour on both sides of the slot: the
// placeholder has to keep its place in the numbering, and the bound value has
// to be the plain id, never the sentinel object.
describe("sharedWith filters", () => {
  const alice = sharedWith({ user_id: "u1" });

  it("sharedWith carries the user's id and nothing else", () => {
    const filter = sharedWith({ user_id: "u1", username: "alice" } as { user_id: string });
    expect(filter).toBeInstanceOf(SharedWith);
    expect(filter.user_id).toBe("u1");
    expect(Object.keys(filter)).toEqual(["user_id"]);
  });

  it("sharedWithSql matches the column against the sharing function of the placeholder", () => {
    expect(SHARING_USER_IDS).toBe("sharing_user_ids");
    expect(sharedWithSql("t.user_id", "$2")).toBe("t.user_id = ANY(sharing_user_ids($2))");
  });

  it("sharingLockKeySql is the smallest member id of the placeholder's group", () => {
    expect(sharingLockKeySql("$1")).toBe(
      "(SELECT min(member::text) FROM unnest(sharing_user_ids($1)) member)",
    );
  });

  it("prepareQuery renders the group predicate in place and binds the plain id", () => {
    const { sql, values } = prepareQuery({ account_id: "a1", user_id: alice, label: "x" });
    expect(sql).toBe(
      "WHERE account_id = $1 AND user_id = ANY(sharing_user_ids($2)) AND label = $3" +
        ` AND ${SOFT_DELETE_CONDITION}`,
    );
    expect(values).toStrictEqual(["a1", "u1", "x"]);
  });

  it("prepareQuery keeps a plain owner id as an equality in the same slot", () => {
    const { sql, values } = prepareQuery({ account_id: "a1", user_id: "u1", label: "x" });
    expect(sql).toBe(
      `WHERE account_id = $1 AND user_id = $2 AND label = $3 AND ${SOFT_DELETE_CONDITION}`,
    );
    expect(values).toStrictEqual(["a1", "u1", "x"]);
  });

  it("prepareQuery numbers the group predicate from startIndex", () => {
    const { sql, values } = prepareQuery(
      { "t.user_id": alice },
      { startIndex: 4, excludeDeleted: false },
    );
    expect(sql).toBe("WHERE t.user_id = ANY(sharing_user_ids($4))");
    expect(values).toStrictEqual(["u1"]);
  });

  it("buildSelectWithFilters renders a filters entry as the group predicate, numbered between its neighbours", () => {
    const { sql, values } = buildSelectWithFilters("transactions", "*", {
      primaryKey: { column: "id", value: "t1" },
      filters: { account_id: "a1", user_id: alice, label: "x" },
      inFilters: { category_id: ["c1"] },
    });
    expect(sql).toBe(
      "SELECT * FROM transactions WHERE id = $1 AND account_id = $2" +
        " AND user_id = ANY(sharing_user_ids($3)) AND label = $4 AND category_id IN ($5)" +
        ` AND ${SOFT_DELETE_CONDITION}`,
    );
    expect(values).toStrictEqual(["t1", "a1", "u1", "x", "c1"]);
  });

  it("buildSelectWithFilters keeps a plain owner id in filters as an equality", () => {
    const { sql, values } = buildSelectWithFilters("transactions", "*", {
      filters: { account_id: "a1", user_id: "u1" },
      excludeDeleted: false,
    });
    expect(sql).toBe("SELECT * FROM transactions WHERE account_id = $1 AND user_id = $2");
    expect(values).toStrictEqual(["a1", "u1"]);
  });

  it("buildSelectWithFilters renders the user_id option as the group predicate at $1", () => {
    const { sql, values } = buildSelectWithFilters("transactions", "*", {
      user_id: alice,
      filters: { account_id: "a1" },
      limit: 5,
    });
    expect(sql).toBe(
      "SELECT * FROM transactions WHERE user_id = ANY(sharing_user_ids($1)) AND account_id = $2" +
        ` AND ${SOFT_DELETE_CONDITION} LIMIT $3`,
    );
    expect(values).toStrictEqual(["u1", "a1", 5]);
  });

  it("buildUpdate renders a sharedWith additionalWhere as the group predicate after the key", () => {
    const q = buildUpdate(
      "transactions",
      "id",
      "t1",
      { amount: 5 },
      { additionalWhere: { column: "user_id", value: alice } },
    );
    expect(q!.sql).toBe(
      "UPDATE transactions SET updated = CURRENT_TIMESTAMP, amount = $1 WHERE id = $2" +
        ` AND user_id = ANY(sharing_user_ids($3)) AND ${SOFT_DELETE_CONDITION}`,
    );
    expect(q!.values).toStrictEqual([5, "t1", "u1"]);
  });

  it("buildUpdate numbers a sharedWith additionalWhere in sequence with the ones around it", () => {
    const q = buildUpdate(
      "transactions",
      "id",
      "t1",
      { amount: 5 },
      {
        additionalWhere: [
          { column: "account_id", value: "a1" },
          { column: "user_id", value: alice },
          { column: "label_category_id", value: null },
          { column: "label_category_confidence", value: 1 },
        ],
        returning: ["id"],
      },
    );
    expect(q!.sql).toBe(
      "UPDATE transactions SET updated = CURRENT_TIMESTAMP, amount = $1 WHERE id = $2" +
        " AND account_id = $3 AND user_id = ANY(sharing_user_ids($4))" +
        " AND label_category_id IS NULL AND label_category_confidence = $5" +
        ` AND ${SOFT_DELETE_CONDITION} RETURNING id`,
    );
    expect(q!.values).toStrictEqual([5, "t1", "a1", "u1", 1]);
  });

  it("buildSoftDelete renders a sharedWith additionalWhere as the group predicate at $2", () => {
    const { sql, values } = buildSoftDelete("transactions", "id", "t1", {
      column: "user_id",
      value: alice,
    });
    expect(sql).toBe(
      "UPDATE transactions SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE id = $1" +
        " AND user_id = ANY(sharing_user_ids($2)) RETURNING id",
    );
    expect(values).toStrictEqual(["t1", "u1"]);
  });
});

// The other half of the sentinel: it names a group, so it can filter rows but
// can't be the owner written to one. Each builder that writes column values
// refuses it rather than binding the object.
describe("sharedWith as a value to store", () => {
  const alice = sharedWith({ user_id: "u1" });
  const REFUSAL = "sharedWith() scopes a query to a sharing group; it is not a value to store";

  it("prepareParamValue refuses it", () => {
    expect(() => prepareParamValue(alice as never)).toThrow(REFUSAL);
  });

  it("buildInsert refuses it as a column value", () => {
    expect(() => buildInsert("charts", { name: "c", user_id: alice as never })).toThrow(REFUSAL);
  });

  it("buildUpdate refuses it as a SET value", () => {
    expect(() => buildUpdate("charts", "chart_id", "c1", { name: "c", user_id: alice })).toThrow(
      REFUSAL,
    );
  });

  it("buildUpsert refuses it as a column value", () => {
    expect(() => buildUpsert("charts", "chart_id", { chart_id: "c1", user_id: alice })).toThrow(
      REFUSAL,
    );
  });

  it("buildUpsertMany refuses it in any row", () => {
    expect(() =>
      buildUpsertMany("charts", "chart_id", [
        { chart_id: "c1", user_id: "u1" },
        { chart_id: "c2", user_id: alice },
      ]),
    ).toThrow(REFUSAL);
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

  it("buildCreateIndex builds a composite index over multiple columns", () => {
    expect(buildCreateIndex("transactions", ["user_id", "updated"])).toBe(
      "CREATE INDEX IF NOT EXISTS idx_transactions_user_id_updated ON transactions(user_id, updated)",
    );
    // A single-element array matches the scalar form exactly (no trailing comma/space).
    expect(buildCreateIndex("things", ["name"])).toBe(
      buildCreateIndex("things", "name"),
    );
  });

  it("buildCreateIndex builds a unique index over an expression, partial when given a predicate", () => {
    expect(
      buildCreateIndex("users", "lower(email)", "idx_users_lower_email", {
        unique: true,
        where: "email IS NOT NULL",
      }),
    ).toBe(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_lower_email ON users(lower(email)) WHERE email IS NOT NULL",
    );
    expect(buildCreateIndex("things", "name", undefined, { unique: true })).toBe(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_things_name ON things(name)",
    );
  });

  it("buildSelectDuplicateKeys selects only the shared keys of the rows the index would cover", () => {
    expect(buildSelectDuplicateKeys("users", "lower(email)", "email IS NOT NULL")).toBe(
      "SELECT lower(email) FROM users WHERE lower(email) IS NOT NULL AND (email IS NOT NULL)" +
        " GROUP BY lower(email) HAVING COUNT(*) > 1 ORDER BY lower(email)",
    );
    expect(buildSelectDuplicateKeys("things", ["a", "b"])).toBe(
      "SELECT a, b FROM things WHERE a IS NOT NULL AND b IS NOT NULL" +
        " GROUP BY a, b HAVING COUNT(*) > 1 ORDER BY a, b",
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
