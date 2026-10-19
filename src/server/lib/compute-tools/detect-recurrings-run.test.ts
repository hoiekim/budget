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
 * A user whose Netflix recurring was soft-deleted with `revivedStatus`: the
 * active-row lookup returns nothing, and Postgres's full unique key rejects
 * an INSERT for the same (user, merchant, direction) unless it resolves the
 * conflict, in which case the row comes back with the status it had.
 */
const setupSoftDeletedNetflix = (revivedStatus: string) => {
  const respond = async (sql: string) => {
    const flat = sql.replace(/\s+/g, " ");
    if (/FROM users/i.test(flat) && /^ ?SELECT/i.test(flat)) return { rows: [userRow], rowCount: 1 };
    if (/FROM transactions t JOIN accounts/i.test(flat)) {
      const rows = netflixCandidates();
      return { rows, rowCount: rows.length };
    }
    if (/^ ?INSERT INTO recurrings/i.test(flat)) {
      if (!/ON CONFLICT \(user_id, merchant_key, is_income\) DO UPDATE/i.test(flat)) {
        throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
      }
      return { rows: [{ recurring_id: "r-netflix", status: revivedStatus }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  mockQuery.mockImplementation(respond);
  mockClientQuery.mockImplementation(respond);
};

const flatten = (calls: unknown[][]) => calls.map((c) => String(c[0]).replace(/\s+/g, " ").trim());
const statements = () => flatten([...mockQuery.mock.calls, ...mockClientQuery.mock.calls]);

describe("runRecurringDetection", () => {
  test("a merchant whose recurring was soft-deleted revives that row instead of failing the user's run", async () => {
    setupSoftDeletedNetflix("suggested");

    await runRecurringDetection();

    const all = statements();
    expect(all.filter((s) => /^ROLLBACK/i.test(s))).toEqual([]);
    expect(all.filter((s) => /^COMMIT/i.test(s))).toHaveLength(1);
    const insert = all.find((s) => /^INSERT INTO recurrings/i.test(s))!;
    const revive = insert.slice(insert.indexOf("DO UPDATE SET") + "DO UPDATE SET".length);
    expect(revive.trim()).toBe(
      "cadence = EXCLUDED.cadence, transaction_ids = EXCLUDED.transaction_ids, is_deleted = FALSE, updated = CURRENT_TIMESTAMP WHERE recurrings.is_deleted = TRUE RETURNING recurring_id, status",
    );
  });

  test("a revived confirmed recurring labels its new charges", async () => {
    setupSoftDeletedNetflix("confirmed");

    await runRecurringDetection();

    const labelLookup = statements().find((s) => /^SELECT label_budget_id, label_category_id, transaction_ids FROM recurrings/i.test(s));
    expect(labelLookup).toBeDefined();
  });

  test("a revived dismissed recurring stays out of labelling", async () => {
    setupSoftDeletedNetflix("dismissed");

    await runRecurringDetection();

    expect(statements().some((s) => /^SELECT label_budget_id, label_category_id, transaction_ids FROM recurrings/i.test(s))).toBe(false);
  });

  test("existing recurrings are read inside the run's transaction, after stale cleanup", async () => {
    setupSoftDeletedNetflix("suggested");

    await runRecurringDetection();

    const onClient = flatten(mockClientQuery.mock.calls);
    const cleanup = onClient.findIndex((s) => /^UPDATE recurrings r SET is_deleted = TRUE/i.test(s));
    const lookup = onClient.findIndex((s) => /^SELECT .* FROM recurrings/i.test(s) && !/label_budget_id, label_category_id, transaction_ids/.test(s));
    expect(cleanup).toBeGreaterThanOrEqual(0);
    expect(lookup).toBeGreaterThan(cleanup);
  });
});
