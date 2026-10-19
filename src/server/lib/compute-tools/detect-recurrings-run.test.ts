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

/** Monthly Netflix charges ending last month, so Netflix qualifies. */
const netflixCandidates = () => {
  const lastMonth = new Date();
  lastMonth.setDate(1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return [0, 1, 2, 3].map((i) => {
    const d = new Date(lastMonth.getFullYear(), lastMonth.getMonth() - i, 15);
    return {
      transaction_id: `netflix-${i}`,
      amount: "15.99",
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      merchant_name: "Netflix",
      name: "Netflix",
    };
  });
};

/**
 * A user whose Netflix recurring was soft-deleted: the active-row lookup
 * returns nothing, and Postgres's full unique key rejects an INSERT for the
 * same (user, merchant, direction) unless it resolves the conflict.
 */
const setupSoftDeletedNetflix = () => {
  const respond = async (sql: string) => {
    const flat = sql.replace(/\s+/g, " ");
    if (/FROM users/i.test(flat) && /^ ?SELECT/i.test(flat)) return { rows: [userRow], rowCount: 1 };
    if (/FROM transactions t JOIN accounts/i.test(flat)) {
      const rows = netflixCandidates();
      return { rows, rowCount: rows.length };
    }
    if (/^ ?INSERT INTO recurrings/i.test(flat) && !/ON CONFLICT \(user_id, merchant_key, is_income\) DO UPDATE/i.test(flat)) {
      throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
    }
    return { rows: [], rowCount: 0 };
  };
  mockQuery.mockImplementation(respond);
  mockClientQuery.mockImplementation(respond);
};

const statements = () =>
  [...mockQuery.mock.calls, ...mockClientQuery.mock.calls].map((c) => String(c[0]).replace(/\s+/g, " ").trim());

describe("runRecurringDetection", () => {
  test("a merchant whose recurring was soft-deleted is suggested again instead of failing the user's run", async () => {
    setupSoftDeletedNetflix();

    await runRecurringDetection();

    const all = statements();
    expect(all.filter((s) => /^ROLLBACK/i.test(s))).toEqual([]);
    expect(all.filter((s) => /^COMMIT/i.test(s))).toHaveLength(1);
    const insert = all.find((s) => /^INSERT INTO recurrings/i.test(s))!;
    const revive = insert.slice(insert.indexOf("DO UPDATE SET"));
    expect(revive).toContain("status = 'suggested'");
    expect(revive).toContain("is_deleted = FALSE");
    expect(revive.endsWith("WHERE recurrings.is_deleted = TRUE")).toBe(true);
  });
});
