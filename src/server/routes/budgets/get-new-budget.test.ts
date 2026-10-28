import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";

type Row = Record<string, unknown>;

const db = {
  insertReturns: [] as Row[],
};

const { driver, mockUnsafe } = createFakeSql(async (sql: string, _values?: unknown[]) => {
  const rows = /^\s*INSERT\s+INTO\s+budgets\b/i.test(sql) ? db.insertReturns : [];
  return { rows: rows as unknown[], rowCount: rows.length as number | null };
});

mock.module("../../lib/postgres/sql-driver", () => driver);

const { getNewBudgetRoute } = await import("./get-new-budget");

afterAll(() => {
  restoreLeaves();
});

beforeEach(() => {
  mockUnsafe.mockClear();
  db.insertReturns = [];
});

const USER_ID = "11111111-1111-1111-1111-111111111111";
const BUDGET_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

const makeReq = (user?: { user_id: string; username: string }) =>
  ({
    method: "GET",
    path: "/new-budget",
    url: "http://x/api/new-budget",
    headers: {},
    query: {},
    body: undefined,
    session: {
      id: "s-1",
      user,
      regenerate() {},
      destroy() {},
    },
    ip: "127.0.0.1",
  }) as unknown as Parameters<typeof getNewBudgetRoute.execute>[0];

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
  }) as unknown as Parameters<typeof getNewBudgetRoute.execute>[1];

const CAPACITY_ID = "9c1d3a44-2b6e-4f10-8f7a-1d5c2e6b0a93";

/** Every field disagrees with the literal `createBudget` defaults to, so a
 *  route that echoed the row and a route that synthesised a constant cannot
 *  produce the same response on this data. */
const insertedRow = (): Row => ({
  budget_id: BUDGET_ID,
  user_id: USER_ID,
  name: "Renamed",
  iso_currency_code: "EUR",
  roll_over: true,
  roll_over_start_date: "2026-01-15",
  capacities: [{ capacity_id: CAPACITY_ID, month: 1200 }],
  updated: "2026-09-02T00:00:00.000Z",
  is_deleted: false,
});

describe("get-new-budget response body", () => {
  test("the response body is the inserted row, not a synthesised default", async () => {
    db.insertReturns = [insertedRow()];

    const result = await getNewBudgetRoute.execute(
      makeReq({ user_id: USER_ID, username: "test" }),
      fakeRes(),
    );

    expect(result?.status).toBe("success");
    const { budget } = (result as { body: { budget: Record<string, unknown> } }).body;
    expect(budget.budget_id).toBe(BUDGET_ID);
    expect(budget.name).toBe("Renamed");
    expect(budget.iso_currency_code).toBe("EUR");
    expect(budget.roll_over).toBe(true);
    expect(budget.roll_over_start_date).toBe("2026-01-15");
    expect(budget.capacities).toEqual([{ capacity_id: CAPACITY_ID, month: 1200 }]);
  });

  test("the response ships only the whitelisted budget fields", async () => {
    db.insertReturns = [insertedRow()];

    const result = await getNewBudgetRoute.execute(
      makeReq({ user_id: USER_ID, username: "test" }),
      fakeRes(),
    );

    const { budget } = (result as { body: { budget: Record<string, unknown> } }).body;
    expect(Object.keys(budget).sort()).toEqual([
      "budget_id",
      "capacities",
      "iso_currency_code",
      "name",
      "roll_over",
      "roll_over_start_date",
    ]);
  });

  test("the insert carries the new-budget defaults", async () => {
    db.insertReturns = [insertedRow()];

    await getNewBudgetRoute.execute(
      makeReq({ user_id: USER_ID, username: "test" }),
      fakeRes(),
    );

    const [, values] = mockUnsafe.mock.calls[0];
    expect(values).toContain("New Budget");
    expect(values).toContain("USD");
    expect(values).toContain(false);
    expect(values).toContain(USER_ID);
  });

  test("a failed insert reports failure instead of a body", async () => {
    db.insertReturns = [];

    const result = await getNewBudgetRoute.execute(
      makeReq({ user_id: USER_ID, username: "test" }),
      fakeRes(),
    );

    expect(result?.status).toBe("failed");
    expect((result as { message?: string }).message).toBe("Failed to create budget.");
  });

  test("an unauthenticated request never reaches the insert", async () => {
    const result = await getNewBudgetRoute.execute(makeReq(undefined), fakeRes());

    expect(result?.status).toBe("failed");
    expect(mockUnsafe).not.toHaveBeenCalled();
  });
});
