import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakePg, restoreLeaves } from "test-helpers";

const { pg, mockQuery, mockClientQuery, resetQueryMocks } = createFakePg();

mock.module("pg", () => pg);

const { runRecurringDetection } = await import("./detect-recurrings");

afterAll(restoreLeaves);

beforeEach(resetQueryMocks);

const USER_ID = "00000000-0000-4000-8000-000000000001";

const userRow = {
  user_id: USER_ID,
  username: "alice",
  password: null,
  email: null,
  expiry: null,
  token: null,
  updated: "2026-05-19T00:00:00.000Z",
  is_deleted: false,
};

const recurringRow = (merchant_key: string, status: string, recurring_id: string) => ({
  recurring_id,
  user_id: USER_ID,
  merchant_key,
  merchant_name: merchant_key,
  cadence: "monthly",
  is_income: false,
  status,
  transaction_ids: [`${merchant_key}-member`],
  label_budget_id: null,
  label_category_id: null,
  created_at: null,
  updated: null,
  is_deleted: false,
});

/** Monthly Netflix charges ending last month, so Netflix qualifies. */
const netflixCandidates = () => {
  const lastMonth = new Date();
  lastMonth.setDate(1);
  return [0, 1, 2, 3].map((i) => {
    const d = new Date(lastMonth.getFullYear(), lastMonth.getMonth() - i, 15);
    const pad = (n: number) => String(n).padStart(2, "0");
    return {
      transaction_id: `netflix-${i}`,
      amount: "15.99",
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      merchant_name: "Netflix",
      name: "Netflix",
    };
  });
};

const setupMock = (recurrings: ReturnType<typeof recurringRow>[]) => {
  const respond = async (sql: string) => {
    if (/FROM\s+users/i.test(sql) && /^SELECT/i.test(sql.trim())) {
      return { rows: [userRow], rowCount: 1 };
    }
    if (/FROM\s+transactions\s+t\s+JOIN\s+accounts/i.test(sql)) {
      const rows = netflixCandidates();
      return { rows, rowCount: rows.length };
    }
    if (/^SELECT/i.test(sql.trim()) && /FROM\s+recurrings/i.test(sql)) {
      return { rows: recurrings, rowCount: recurrings.length };
    }
    return { rows: [], rowCount: 0 };
  };
  mockQuery.mockImplementation(respond);
  mockClientQuery.mockImplementation(respond);
};

const withdrawCalls = () =>
  [...mockQuery.mock.calls, ...mockClientQuery.mock.calls]
    .map((c) => ({ sql: String(c[0]).replace(/\s+/g, " "), values: c[1] as unknown[] }))
    .filter((c) => /^ ?UPDATE recurrings SET is_deleted = TRUE/i.test(c.sql) && /ANY\(\$2::uuid\[\]\)/.test(c.sql));

describe("runRecurringDetection", () => {
  test("withdraws a suggestion whose merchant no longer qualifies, and only that one", async () => {
    setupMock([
      recurringRow("netflix", "suggested", "00000000-0000-4000-8000-0000000000a1"),
      recurringRow("manual db bkrg 07 03", "suggested", "00000000-0000-4000-8000-0000000000a2"),
      recurringRow("gym", "confirmed", "00000000-0000-4000-8000-0000000000a3"),
      recurringRow("magazine", "dismissed", "00000000-0000-4000-8000-0000000000a4"),
    ]);

    await runRecurringDetection();

    const calls = withdrawCalls();
    expect(calls.map((c) => c.values)).toEqual([[USER_ID, ["00000000-0000-4000-8000-0000000000a2"]]]);
  });

  test("withdraws nothing while every suggestion still qualifies", async () => {
    setupMock([recurringRow("netflix", "suggested", "00000000-0000-4000-8000-0000000000a1")]);

    await runRecurringDetection();

    expect(withdrawCalls()).toHaveLength(0);
  });
});
