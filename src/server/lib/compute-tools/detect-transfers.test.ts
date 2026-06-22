//
// `runTransferDetection` lost its DI seams (queryFn / logger /
// fetchUsers / fetchCandidates / createPair). The function now calls
// `usersTable.query` and `pool.query` directly, and writes to the real
// `logger`. Bundle inlines all of that; the test leaf-mocks `pg` so
// every SELECT/INSERT lands on `mockQuery` and stages responses per
// scenario. The real logger emits its info/error lines to stderr —
// no behaviour change from the original `noopLogger` since the test's
// assertions never read those calls.
import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";

const mockQuery = mock(async (_sql: string, _values?: unknown[]) => ({
  rows: [] as unknown[],
  rowCount: 0 as number | null,
}));

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

const { runTransferDetection, scoreConfidence } = await import("./detect\-transfers");

afterAll(restoreLeaves);

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
});

/** Raw users row matching UserModel's schema. */
const userRow = (overrides: Record<string, unknown> = {}) => ({
  user_id: "u-1",
  username: "alice",
  password: null,
  email: null,
  expiry: null,
  token: null,
  updated: "2026-05-19T00:00:00.000Z",
  is_deleted: false,
  ...overrides,
});

/**
 * Helper: find every call against `transaction_pairs` INSERT. The
 * route issues one INSERT per accepted candidate.
 */
const findInsertCalls = (): Array<{ sql: string; values: unknown[] }> =>
  mockQuery.mock.calls
    .map((c) => ({ sql: c[0] as string, values: c[1] as unknown[] }))
    .filter((c) => /INSERT\s+INTO\s+transaction_pairs/i.test(c.sql));

describe("scoreConfidence", () => {
  test("returns 0.7 base for a same-window non-Plaid match", () => {
    expect(scoreConfidence(false, 2)).toBe(0.7);
  });

  test("adds 0.2 when Plaid tagged either side as TRANSFER_*", () => {
    expect(scoreConfidence(true, 2)).toBeCloseTo(0.9);
  });

  test("adds 0.1 same-day boost", () => {
    expect(scoreConfidence(false, 0)).toBeCloseTo(0.8);
  });

  test("stacks Plaid + same-day, capped at 0.99", () => {
    expect(scoreConfidence(true, 0)).toBeCloseTo(0.99);
  });

  test("does not apply same-day boost when delta is 1 day", () => {
    expect(scoreConfidence(false, 1)).toBe(0.7);
  });
});

describe("runTransferDetection", () => {
  test("does nothing when there are no users", async () => {
    // SELECT users returns empty → loop doesn't enter.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await runTransferDetection();

    expect(findInsertCalls()).toHaveLength(0);
  });

  test("inserts a pair for a single candidate above threshold", async () => {
    // SELECT users → [user-1]
    mockQuery.mockResolvedValueOnce({ rows: [userRow({ user_id: "user-1" })], rowCount: 1 });
    // Stale-pair cleanup UPDATE — runs before fetchCandidates (0 cleaned).
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // SELECT candidates for user-1 → one matching pair
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          transaction_id_a: "txn-a",
          transaction_id_b: "txn-b",
          date_delta: 1,
          is_plaid_transfer: false,
        },
      ],
      rowCount: 1,
    });
    // INSERT transaction_pairs
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await runTransferDetection();

    const inserts = findInsertCalls();
    expect(inserts).toHaveLength(1);
    // Insert carries user_id + both transaction_ids.
    expect(inserts[0].values).toContain("user-1");
    expect(inserts[0].values).toContain("txn-a");
    expect(inserts[0].values).toContain("txn-b");
  });

  test("prevents a single transaction from being paired twice in one run", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [userRow({ user_id: "user-1" })], rowCount: 1 });
    // Stale-pair cleanup UPDATE.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          transaction_id_a: "txn-shared",
          transaction_id_b: "txn-1",
          date_delta: 0,
          is_plaid_transfer: false,
        },
        {
          transaction_id_a: "txn-shared",
          transaction_id_b: "txn-2",
          date_delta: 1,
          is_plaid_transfer: false,
        },
        {
          transaction_id_a: "txn-1",
          transaction_id_b: "txn-3",
          date_delta: 0,
          is_plaid_transfer: false,
        },
      ],
      rowCount: 3,
    });
    // Only ONE INSERT should fire — the second/third candidates are
    // skipped because their txn ids are already used in the first pair.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await runTransferDetection();

    const inserts = findInsertCalls();
    expect(inserts).toHaveLength(1);
    // First candidate consumed txn-shared + txn-1.
    expect(inserts[0].values).toContain("txn-shared");
    expect(inserts[0].values).toContain("txn-1");
    expect(inserts[0].values).not.toContain("txn-2");
    expect(inserts[0].values).not.toContain("txn-3");
  });

  test("processes each user independently and isolates failures", async () => {
    // SELECT users → [user-bad, user-good]
    mockQuery.mockResolvedValueOnce({
      rows: [userRow({ user_id: "user-bad" }), userRow({ user_id: "user-good" })],
      rowCount: 2,
    });
    // user-bad's stale-pair cleanup UPDATE — throws (simulates fail point)
    mockQuery.mockRejectedValueOnce(new Error("boom"));
    // user-good's stale-pair cleanup UPDATE → 0 cleaned.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // user-good's SELECT candidates → one matching pair
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          transaction_id_a: "g-a",
          transaction_id_b: "g-b",
          date_delta: 0,
          is_plaid_transfer: true,
        },
      ],
      rowCount: 1,
    });
    // INSERT for user-good's pair
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await runTransferDetection();

    const inserts = findInsertCalls();
    expect(inserts).toHaveLength(1);
    expect(inserts[0].values).toContain("user-good");
    expect(inserts[0].values).toContain("g-a");
    expect(inserts[0].values).toContain("g-b");
  });

  test("logs but continues when an INSERT throws", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [userRow({ user_id: "user-1" })], rowCount: 1 });
    // Stale-pair cleanup UPDATE.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // SELECT candidates → two matching pairs
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          transaction_id_a: "a1",
          transaction_id_b: "b1",
          date_delta: 0,
          is_plaid_transfer: false,
        },
        {
          transaction_id_a: "a2",
          transaction_id_b: "b2",
          date_delta: 0,
          is_plaid_transfer: false,
        },
      ],
      rowCount: 2,
    });
    // First INSERT rejects, second succeeds.
    mockQuery.mockRejectedValueOnce(new Error("conflict"));
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await runTransferDetection();

    // Both INSERT attempts fired — the first threw, the second succeeded.
    const inserts = findInsertCalls();
    expect(inserts).toHaveLength(2);
  });

  test("candidate-fetch SQL uses 7-day window + hidden-count tiebreak", async () => {
    // Single user with no candidates — we only inspect the SELECT-candidates
    // SQL shape that the engine issues per user.
    mockQuery.mockResolvedValueOnce({ rows: [userRow({ user_id: "u-1" })], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await runTransferDetection();

    const candidateCalls = mockQuery.mock.calls.filter((c) =>
      /JOIN\s+transactions\s+t2/i.test(c[0] as string),
    );
    expect(candidateCalls).toHaveLength(1);
    const [sql, values] = candidateCalls[0];

    // 7-day window passed as second positional parameter.
    expect((values as unknown[])[1]).toBe(7);

    // Joins both transactions' accounts to expose `.hide`.
    expect(sql as string).toMatch(/JOIN\s+accounts\s+a1\s+ON\s+a1\.account_id\s*=\s*t1\.account_id/i);
    expect(sql as string).toMatch(/JOIN\s+accounts\s+a2\s+ON\s+a2\.account_id\s*=\s*t2\.account_id/i);

    // ORDER BY: date_delta ASC, hidden-count ASC, transaction_id ASC.
    // The hidden-count sub-expression appears both in the SELECT (as a
    // returned column) and in the ORDER BY — match the ORDER BY shape
    // specifically.
    const sqlStr = sql as string;
    const orderByIdx = sqlStr.search(/ORDER\s+BY/i);
    expect(orderByIdx).toBeGreaterThan(-1);
    const tail = sqlStr.slice(orderByIdx);
    expect(tail).toMatch(/ABS\(t1\.date\s*-\s*t2\.date\)\s*ASC/i);
    expect(tail).toMatch(/a1\.hide/i);
    expect(tail).toMatch(/a2\.hide/i);
    expect(tail).toMatch(/t1\.transaction_id\s+ASC/i);
  });
});
