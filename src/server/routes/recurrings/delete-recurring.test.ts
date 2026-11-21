import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";

const { driver, mockUnsafe, mockReservedUnsafe, resetSqlMocks } = createFakeSql();

mock.module("../../lib/postgres/sql-driver", () => driver);

const { dismissRecurringRoute } = await import("./delete-recurring");

afterAll(restoreLeaves);

const OWNER_LOOKUP = /\bFROM\s+recurrings\s+r\s+JOIN\s+users\b/i;
const DISMISS_UPDATE = /^\s*UPDATE\s+recurrings\b/i;

const RECURRING_ID = "5b1f0c9e-3a44-4d0a-9c1e-6f2d8a7b4c10";

let ownerRow: Record<string, unknown> | null = null;
/** Whether the dismissal UPDATE finds a row to change. */
let updateMatches = true;

const queryRouter = async (sql: string) => {
  if (OWNER_LOOKUP.test(sql)) {
    return ownerRow ? { rows: [ownerRow], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (DISMISS_UPDATE.test(sql)) {
    return updateMatches
      ? { rows: [{ recurring_id: RECURRING_ID }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }
  return { rows: [], rowCount: 0 };
};

beforeEach(() => {
  resetSqlMocks();
  mockUnsafe.mockImplementation(queryRouter);
  ownerRow = null;
  updateMatches = true;
});

type Statement = { sql: string; values: unknown[] };

const find = (matcher: RegExp): Statement | null => {
  for (const call of mockUnsafe.mock.calls) {
    const sql = call[0] as string;
    if (matcher.test(sql)) return { sql, values: (call[1] ?? []) as unknown[] };
  }
  return null;
};

/** The value the statement compares `column` against in its WHERE clause. */
const whereValue = ({ sql, values }: Statement, column: string): unknown => {
  const where = sql.slice(sql.search(/\bWHERE\b/i));
  const match = new RegExp(`\\b${column} = \\$(\\d+)`).exec(where)!;
  return values[Number(match[1]) - 1];
};

function makeReq(query: Record<string, unknown> = {}, userId: string | null = "u-member") {
  return {
    method: "DELETE",
    path: "/recurrings",
    url: "http://x/api/recurrings",
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
  } as unknown as Parameters<typeof dismissRecurringRoute.execute>[0];
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
  }) as unknown as Parameters<typeof dismissRecurringRoute.execute>[1];

describe("DELETE /recurrings", () => {
  test("registers as DELETE /recurrings", () => {
    expect(dismissRecurringRoute.method).toBe("DELETE");
    expect(dismissRecurringRoute.path).toBe("/recurrings");
  });

  test("rejects unauthenticated requests without touching the database", async () => {
    const result = await dismissRecurringRoute.execute(makeReq({ id: RECURRING_ID }, null), fakeRes());
    expect(result).toEqual({ status: "failed", message: "Request user is not authenticated." });
    expect(mockUnsafe).not.toHaveBeenCalled();
    expect(mockReservedUnsafe).not.toHaveBeenCalled();
  });

  test("rejects a missing id before any query", async () => {
    const result = await dismissRecurringRoute.execute(makeReq({}), fakeRes());
    expect(result).toEqual({ status: "failed", message: "Missing required parameter: id" });
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("rejects a repeated id before any query", async () => {
    const result = await dismissRecurringRoute.execute(makeReq({ id: [RECURRING_ID, RECURRING_ID] }), fakeRes());
    expect(result?.status).toBe("failed");
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test("a recurring someone else in the sharing group owns is dismissed as its owner", async () => {
    ownerRow = { user_id: "u-owner", username: "owner" };

    const result = await dismissRecurringRoute.execute(makeReq({ id: RECURRING_ID }, "u-member"), fakeRes());

    expect(result).toEqual({ status: "success" });
    const update = find(DISMISS_UPDATE);
    expect(update).not.toBeNull();
    expect(whereValue(update!, "user_id")).toBe("u-owner");
    expect(update!.values).not.toContain("u-member");
    expect(whereValue(update!, "recurring_id")).toBe(RECURRING_ID);
    expect(update!.values).toContain("dismissed");
  });

  test("the owner lookup is keyed on the live recurring and scoped to the caller's sharing group", async () => {
    ownerRow = { user_id: "u-owner", username: "owner" };

    await dismissRecurringRoute.execute(makeReq({ id: RECURRING_ID }, "u-member"), fakeRes());

    const lookup = find(OWNER_LOOKUP);
    expect(lookup).not.toBeNull();
    expect(lookup!.sql).toMatch(/r\.recurring_id = \$1 AND r\.user_id = ANY\(sharing_user_ids\(\$2\)\)/);
    expect(lookup!.sql).toMatch(/r\.is_deleted IS NULL OR r\.is_deleted = FALSE/);
    expect(lookup!.values).toEqual([RECURRING_ID, "u-member"]);
  });

  test("with no owner in reach the dismissal runs as the session user", async () => {
    ownerRow = null;

    const result = await dismissRecurringRoute.execute(makeReq({ id: RECURRING_ID }, "u-member"), fakeRes());

    expect(result).toEqual({ status: "success" });
    expect(find(OWNER_LOOKUP)).not.toBeNull();
    const update = find(DISMISS_UPDATE);
    expect(update).not.toBeNull();
    expect(whereValue(update!, "user_id")).toBe("u-member");
    expect(whereValue(update!, "recurring_id")).toBe(RECURRING_ID);
  });

  test("a recurring the session user cannot reach answers 'Recurring not found.'", async () => {
    ownerRow = null;
    updateMatches = false;

    const result = await dismissRecurringRoute.execute(makeReq({ id: RECURRING_ID }, "u-member"), fakeRes());

    expect(result).toEqual({ status: "failed", message: "Recurring not found." });
    expect(whereValue(find(DISMISS_UPDATE)!, "user_id")).toBe("u-member");
  });

  test("a dismissal that changes no row is refused even when an owner was found", async () => {
    ownerRow = { user_id: "u-owner", username: "owner" };
    updateMatches = false;

    const result = await dismissRecurringRoute.execute(makeReq({ id: RECURRING_ID }, "u-member"), fakeRes());

    expect(result).toEqual({ status: "failed", message: "Recurring not found." });
  });
});
