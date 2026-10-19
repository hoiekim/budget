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

const BUDGET_ID = "00000000-0000-4000-8000-0000000000b1";
const CATEGORY_ID = "00000000-0000-4000-8000-0000000000c1";

const recurringRow = (
  merchant_key: string,
  status: string,
  transaction_ids: string[],
  is_deleted: boolean,
) => ({
  recurring_id: `00000000-0000-4000-8000-${merchant_key === "netflix" ? "0000000000a1" : "0000000000a9"}`,
  user_id: USER_ID,
  merchant_key,
  merchant_name: merchant_key,
  cadence: "monthly",
  is_income: false,
  status,
  transaction_ids,
  label_budget_id: null,
  label_category_id: null,
  created_at: null,
  updated: null,
  is_deleted,
});

/** An active recurring of another merchant holding `transaction_ids`. */
const activeRow = (transaction_ids: string[]) =>
  recurringRow("subscriptions", "confirmed", transaction_ids, false);

const LABEL_LOOKUP = /^SELECT label_budget_id, label_category_id, transaction_ids FROM recurrings/i;

/**
 * A user whose Netflix recurring was soft-deleted with `revivedStatus`: the
 * active-row lookup returns only `active`, and Postgres's full unique key
 * rejects an INSERT for the same (user, merchant, direction) unless it
 * resolves the conflict, in which case the row comes back with the status it
 * had (and, when confirmed, its default label).
 */
const setupSoftDeletedNetflix = (
  revivedStatus: string | null,
  active: ReturnType<typeof activeRow>[] = [],
) => {
  const recurrings = revivedStatus
    ? [...active, recurringRow("netflix", revivedStatus, ["old-netflix"], true)]
    : active;
  const respond = async (sql: string) => {
    const flat = sql.replace(/\s+/g, " ").trim();
    if (/FROM users/i.test(flat) && /^SELECT/i.test(flat)) return { rows: [userRow], rowCount: 1 };
    if (/FROM transactions t JOIN accounts/i.test(flat)) {
      const rows = netflixCandidates();
      return { rows, rowCount: rows.length };
    }
    if (/^INSERT INTO recurrings/i.test(flat)) {
      if (!/ON CONFLICT \(user_id, merchant_key, is_income\) DO UPDATE/i.test(flat)) {
        throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
      }
      return { rows: [{ recurring_id: "r-netflix", status: revivedStatus ?? "suggested" }], rowCount: 1 };
    }
    if (LABEL_LOOKUP.test(flat)) {
      const rows =
        revivedStatus === "confirmed"
          ? [{ label_budget_id: BUDGET_ID, label_category_id: CATEGORY_ID, transaction_ids: [] }]
          : [];
      return { rows, rowCount: rows.length };
    }
    if (/^SELECT/i.test(flat) && /FROM recurrings/i.test(flat)) {
      const rows = /is_deleted IS NULL OR is_deleted = FALSE/i.test(flat)
        ? recurrings.filter((r) => !r.is_deleted)
        : recurrings;
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  };
  mockQuery.mockImplementation(respond);
  mockClientQuery.mockImplementation(respond);
};

const allCalls = () =>
  [...mockQuery.mock.calls, ...mockClientQuery.mock.calls].map((c) => ({
    sql: String(c[0]).replace(/\s+/g, " ").trim(),
    values: (c[1] ?? []) as unknown[],
  }));
const statements = () => allCalls().map((c) => c.sql);
const insertCall = () => allCalls().find((c) => /^INSERT INTO recurrings/i.test(c.sql));
const labelWrite = () => allCalls().find((c) => /^UPDATE transactions SET label_budget_id/i.test(c.sql));

describe("runRecurringDetection", () => {
  test("a merchant whose recurring was soft-deleted revives that row instead of failing the user's run", async () => {
    setupSoftDeletedNetflix("suggested");

    await runRecurringDetection();

    const all = statements();
    expect(all.filter((s) => /^ROLLBACK/i.test(s))).toEqual([]);
    expect(all.filter((s) => /^COMMIT/i.test(s))).toHaveLength(1);
    const insert = insertCall()!.sql;
    const revive = insert.slice(insert.indexOf("DO UPDATE SET") + "DO UPDATE SET".length);
    expect(revive.trim()).toBe(
      "cadence = EXCLUDED.cadence, transaction_ids = EXCLUDED.transaction_ids, is_deleted = FALSE, updated = CURRENT_TIMESTAMP WHERE recurrings.is_deleted = TRUE RETURNING recurring_id, status",
    );
    expect(insertCall()!.values[6]).toEqual(["netflix-3", "netflix-2", "netflix-1", "netflix-0"]);
  });

  test("a revived confirmed recurring labels its new charges with its default label", async () => {
    setupSoftDeletedNetflix("confirmed");

    await runRecurringDetection();

    const write = labelWrite()!;
    expect(write.values.slice(0, 4)).toEqual([
      USER_ID,
      ["netflix-3", "netflix-2", "netflix-1", "netflix-0"],
      BUDGET_ID,
      CATEGORY_ID,
    ]);
  });

  test("a new suggestion keeps the whole group even where another recurring holds charges", async () => {
    setupSoftDeletedNetflix(null, [activeRow(["netflix-3", "netflix-2"])]);

    await runRecurringDetection();

    expect(insertCall()!.values[6]).toEqual(["netflix-3", "netflix-2", "netflix-1", "netflix-0"]);
  });

  test("a revived suggestion keeps the whole group too", async () => {
    setupSoftDeletedNetflix("suggested", [activeRow(["netflix-3", "netflix-2"])]);

    await runRecurringDetection();

    expect(insertCall()!.values[6]).toEqual(["netflix-3", "netflix-2", "netflix-1", "netflix-0"]);
  });

  test("a revived confirmed recurring leaves charges another active recurring holds with it", async () => {
    setupSoftDeletedNetflix("confirmed", [activeRow(["netflix-3", "netflix-2"])]);

    await runRecurringDetection();

    expect(insertCall()!.values[6]).toEqual(["netflix-1", "netflix-0"]);
    expect(labelWrite()!.values[1]).toEqual(["netflix-1", "netflix-0"]);
  });

  test("a confirmed recurring isn't revived when every charge is already held", async () => {
    setupSoftDeletedNetflix("confirmed", [activeRow(["netflix-3", "netflix-2", "netflix-1", "netflix-0"])]);

    await runRecurringDetection();

    expect(insertCall()).toBeUndefined();
    expect(labelWrite()).toBeUndefined();
  });

  test("a revived dismissed recurring stays out of labelling", async () => {
    setupSoftDeletedNetflix("dismissed");

    await runRecurringDetection();

    expect(statements().some((s) => LABEL_LOOKUP.test(s))).toBe(false);
  });

  test("existing recurrings are read inside the run's transaction, after stale cleanup", async () => {
    setupSoftDeletedNetflix("suggested");

    await runRecurringDetection();

    const onClient = mockClientQuery.mock.calls.map((c) => String(c[0]).replace(/\s+/g, " ").trim());
    const cleanup = onClient.findIndex((s) => /^UPDATE recurrings r SET is_deleted = TRUE/i.test(s));
    const lookup = onClient.findIndex((s) => /^SELECT .* FROM recurrings/i.test(s) && !LABEL_LOOKUP.test(s));
    expect(cleanup).toBeGreaterThanOrEqual(0);
    expect(lookup).toBeGreaterThan(cleanup);
  });
});
