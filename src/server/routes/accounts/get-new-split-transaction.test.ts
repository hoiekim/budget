import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";

const { driver, mockUnsafe, mockReservedUnsafe, resetSqlMocks } = createFakeSql();

mock.module("../../lib/postgres/sql-driver", () => driver);

const { getNewSplitTransactionRoute } = await import("./get-new-split-transaction");

afterAll(restoreLeaves);

const OWNER_LOOKUP = /\bFROM\s+transactions\s+r\s+JOIN\s+users\b/i;
const SPLIT_INSERT = /^\s*INSERT\s+INTO\s+split_transactions\b/i;

type Statement = { sql: string; values: unknown[] };

/** The value a single-row INSERT binds to `column`, read off its own column list. */
const boundTo = (insert: Statement, column: string): unknown => {
  const [, columnList, valueList] = /\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i.exec(insert.sql)!;
  const columns = columnList.split(",").map((c) => c.trim());
  const placeholders = valueList.split(",").map((p) => p.trim());
  return insert.values[Number(placeholders[columns.indexOf(column)].slice(1)) - 1];
};

let ownerRow: Record<string, unknown> | null = null;

// The INSERT answers the row it was asked to write, so the response is read
// back from what the route actually bound.
const queryRouter = async (sql: string, values: unknown[] = []) => {
  if (OWNER_LOOKUP.test(sql)) {
    return ownerRow ? { rows: [ownerRow], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (SPLIT_INSERT.test(sql)) {
    const insert = { sql, values };
    return {
      rows: [
        {
          split_transaction_id: "split-new",
          user_id: boundTo(insert, "user_id"),
          transaction_id: boundTo(insert, "transaction_id"),
          account_id: boundTo(insert, "account_id"),
          amount: 0,
          date: "2026-01-01",
          custom_name: "",
          label_budget_id: null,
          label_category_id: null,
          label_memo: null,
          label_category_confidence: null,
          updated: null,
          is_deleted: false,
        },
      ],
      rowCount: 1,
    };
  }
  return { rows: [], rowCount: 0 };
};

beforeEach(() => {
  resetSqlMocks();
  mockUnsafe.mockImplementation(queryRouter);
  ownerRow = null;
});

const find = (matcher: RegExp): Statement | null => {
  for (const call of mockUnsafe.mock.calls) {
    const sql = call[0] as string;
    if (matcher.test(sql)) return { sql, values: (call[1] ?? []) as unknown[] };
  }
  return null;
};

function makeReq(query: Record<string, unknown> = {}, userId: string | null = "u-member") {
  return {
    method: "GET",
    path: "/new-split-transaction",
    url: "http://x/api/new-split-transaction",
    headers: {},
    query,
    body: undefined,
    session: {
      id: "s-1",
      user: userId ? { user_id: userId, username: "member" } : undefined,
      regenerate() {},
      destroy() {},
    },
    ip: "127.0.0.1",
  } as unknown as Parameters<typeof getNewSplitTransactionRoute.execute>[0];
}

const fakeRes = () =>
  ({
    statusCode: 200,
    headersSent: false,
    status() {
      return this;
    },
    write() {
      return true;
    },
    end() {},
  }) as unknown as Parameters<typeof getNewSplitTransactionRoute.execute>[1];

const QUERY = { transaction_id: "tx-1", account_id: "acc-1" };

describe("GET /new-split-transaction", () => {
  test("rejects unauthenticated requests without touching the database", async () => {
    const result = await getNewSplitTransactionRoute.execute(makeReq(QUERY, null), fakeRes());
    expect(result).toEqual({ status: "failed", message: "Request user is not authenticated." });
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockReservedUnsafe).not.toHaveBeenCalled();
  });

  test("rejects a missing transaction_id before any query", async () => {
    const result = await getNewSplitTransactionRoute.execute(makeReq({ account_id: "acc-1" }), fakeRes());
    expect(result).toEqual({ status: "failed", message: "Missing required parameter: transaction_id" });
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("rejects a missing account_id before any query", async () => {
    const result = await getNewSplitTransactionRoute.execute(makeReq({ transaction_id: "tx-1" }), fakeRes());
    expect(result).toEqual({ status: "failed", message: "Missing required parameter: account_id" });
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("a split on a shared transaction is inserted under the transaction owner's user_id", async () => {
    ownerRow = { user_id: "u-owner", username: "owner" };

    const result = await getNewSplitTransactionRoute.execute(makeReq(QUERY, "u-member"), fakeRes());

    expect(result).toEqual({ status: "success", body: { split_transaction_id: "split-new" } });
    const insert = find(SPLIT_INSERT);
    expect(insert).not.toBeNull();
    expect(boundTo(insert!, "user_id")).toBe("u-owner");
    expect(insert!.values).not.toContain("u-member");
    expect(boundTo(insert!, "transaction_id")).toBe("tx-1");
    expect(boundTo(insert!, "account_id")).toBe("acc-1");
  });

  test("a split on the caller's own transaction is inserted under the caller's user_id", async () => {
    ownerRow = { user_id: "u-member", username: "member" };

    const result = await getNewSplitTransactionRoute.execute(makeReq(QUERY, "u-member"), fakeRes());

    expect(result?.status).toBe("success");
    expect(boundTo(find(SPLIT_INSERT)!, "user_id")).toBe("u-member");
  });

  test("the owner lookup is keyed on the live transaction and scoped to the caller's sharing group", async () => {
    ownerRow = { user_id: "u-owner", username: "owner" };

    await getNewSplitTransactionRoute.execute(makeReq(QUERY, "u-member"), fakeRes());

    const lookup = find(OWNER_LOOKUP);
    expect(lookup).not.toBeNull();
    expect(lookup!.sql).toMatch(/r\.transaction_id = \$1 AND r\.user_id = ANY\(sharing_user_ids\(\$2\)\)/);
    expect(lookup!.sql).toMatch(/r\.is_deleted IS NULL OR r\.is_deleted = FALSE/);
    expect(lookup!.values).toEqual(["tx-1", "u-member"]);
  });

  test("no owner in reach answers 'Transaction not found.' and inserts nothing", async () => {
    ownerRow = null;

    const result = await getNewSplitTransactionRoute.execute(makeReq(QUERY, "u-member"), fakeRes());

    expect(result).toEqual({ status: "failed", message: "Transaction not found." });
    expect(find(OWNER_LOOKUP)).not.toBeNull();
    expect(find(SPLIT_INSERT)).toBeNull();
    expect(mockReservedUnsafe).not.toHaveBeenCalled();
  });
});
