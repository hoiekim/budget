import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";

type Row = Record<string, unknown>;

const db = {
  insertReturns: [] as Row[],
};

const mockQuery = mock(async (sql: string, _values?: unknown[]) => {
  const rows = /^\s*INSERT\s+INTO\s+budgets\b/i.test(sql) ? db.insertReturns : [];
  return { rows: rows as unknown[], rowCount: rows.length as number | null };
});

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

const { getNewBudgetRoute } = await import("./get-new-budget");

afterAll(() => {
  restoreLeaves();
});

beforeEach(() => {
  mockQuery.mockClear();
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

const insertedRow = (): Row => ({
  budget_id: BUDGET_ID,
  user_id: USER_ID,
  name: "New Budget",
  iso_currency_code: "USD",
  roll_over: false,
  roll_over_start_date: null,
  capacities: [],
  updated: "2026-09-02T00:00:00.000Z",
  is_deleted: false,
});

describe("get-new-budget response body", () => {
  test("returns the created budget, name included, so the client store matches the row", async () => {
    db.insertReturns = [insertedRow()];

    const result = await getNewBudgetRoute.execute(
      makeReq({ user_id: USER_ID, username: "test" }),
      fakeRes(),
    );

    expect(result?.status).toBe("success");
    const { budget } = (result as { body: { budget: Record<string, unknown> } }).body;
    expect(budget.budget_id).toBe(BUDGET_ID);
    expect(budget.name).toBe("New Budget");
    expect(budget.iso_currency_code).toBe("USD");
    expect(budget.roll_over).toBe(false);
    expect(budget.capacities).toEqual([]);

    const [, values] = mockQuery.mock.calls[0];
    expect(values).toContain("New Budget");
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
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
