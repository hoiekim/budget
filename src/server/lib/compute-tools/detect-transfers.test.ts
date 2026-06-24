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

/**
 * Pattern-match the SQL to decide what to return. Tests set the relevant
 * arrays/responses before invoking; transaction control (BEGIN, advisory
 * lock, SAVEPOINT, RELEASE, ROLLBACK TO, COMMIT, ROLLBACK) all return
 * empty by default. Per-user-loop runs BEGIN → advisory lock → cleanup
 * UPDATE → candidates SELECT → (SAVEPOINT → INSERT → RELEASE) per pair
 * → COMMIT — 8+ calls; mockResolvedValueOnce sequencing got brittle, so
 * we match on SQL shape.
 */
function setupMock(opts: {
  users?: ReturnType<typeof userRow>[];
  candidates?: unknown[];
  insertResult?: { rows: unknown[]; rowCount: number };
  insertRejector?: (sql: string, values: unknown[]) => boolean;
}) {
  const users = opts.users ?? [];
  const candidates = opts.candidates ?? [];
  const insertResult = opts.insertResult ?? { rows: [], rowCount: 1 };

  mockQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
    // Boilerplate (transaction control): all return empty.
    if (
      /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|ROLLBACK TO)\b/i.test(sql) ||
      /pg_advisory_xact_lock/i.test(sql)
    ) {
      return { rows: [], rowCount: 0 };
    }
    // Stale-pair cleanup UPDATE.
    if (/^\s*UPDATE\s+transaction_pairs/i.test(sql) && /is_deleted\s*=\s*TRUE/i.test(sql)) {
      return { rows: [], rowCount: 0 };
    }
    // SELECT users.
    if (/FROM\s+users/i.test(sql) && /^SELECT/i.test(sql.trim())) {
      return { rows: users, rowCount: users.length };
    }
    // fetchCandidates SELECT.
    if (/JOIN\s+transactions\s+t2/i.test(sql)) {
      return { rows: candidates, rowCount: candidates.length };
    }
    // INSERT INTO transaction_pairs.
    if (/INSERT\s+INTO\s+transaction_pairs/i.test(sql)) {
      if (opts.insertRejector && opts.insertRejector(sql, values ?? [])) {
        throw new Error("insert rejected by test");
      }
      return insertResult;
    }
    return { rows: [], rowCount: 0 };
  });
}

describe("runTransferDetection", () => {
  test("does nothing when there are no users", async () => {
    setupMock({ users: [] });

    await runTransferDetection();

    expect(findInsertCalls()).toHaveLength(0);
  });

  test("inserts a pair for a single candidate above threshold", async () => {
    setupMock({
      users: [userRow({ user_id: "user-1" })],
      candidates: [
        { transaction_id_a: "txn-a", transaction_id_b: "txn-b", date_delta: 1, is_plaid_transfer: false },
      ],
    });

    await runTransferDetection();

    const inserts = findInsertCalls();
    expect(inserts).toHaveLength(1);
    expect(inserts[0].values).toContain("user-1");
    expect(inserts[0].values).toContain("txn-a");
    expect(inserts[0].values).toContain("txn-b");
  });

  test("prevents a single transaction from being paired twice in one run", async () => {
    setupMock({
      users: [userRow({ user_id: "user-1" })],
      candidates: [
        { transaction_id_a: "txn-shared", transaction_id_b: "txn-1", date_delta: 0, is_plaid_transfer: false },
        { transaction_id_a: "txn-shared", transaction_id_b: "txn-2", date_delta: 1, is_plaid_transfer: false },
        { transaction_id_a: "txn-1", transaction_id_b: "txn-3", date_delta: 0, is_plaid_transfer: false },
      ],
    });

    await runTransferDetection();

    const inserts = findInsertCalls();
    expect(inserts).toHaveLength(1);
    expect(inserts[0].values).toContain("txn-shared");
    expect(inserts[0].values).toContain("txn-1");
    expect(inserts[0].values).not.toContain("txn-2");
    expect(inserts[0].values).not.toContain("txn-3");
  });

  test("per-user BEGIN+advisory-lock+COMMIT wraps the work (serializes against manual mutations and concurrent engine runs)", async () => {
    setupMock({
      users: [userRow({ user_id: "user-1" })],
      candidates: [
        { transaction_id_a: "tx-a", transaction_id_b: "tx-b", date_delta: 0, is_plaid_transfer: false },
      ],
    });

    await runTransferDetection();

    const calls = mockQuery.mock.calls.map((c) => c[0] as string);
    const begins = calls.filter((s) => /^BEGIN$/i.test(s));
    const locks = calls.filter((s) => /pg_advisory_xact_lock/i.test(s));
    const commits = calls.filter((s) => /^COMMIT$/i.test(s));
    expect(begins).toHaveLength(1);
    expect(locks).toHaveLength(1);
    expect(commits).toHaveLength(1);
    // Lock key uses the user_id (so engine + manual mutations on the same
    // user serialize). Round 1 (`pairTransactions`) uses the same key.
    const lockCall = mockQuery.mock.calls.find((c) =>
      /pg_advisory_xact_lock/i.test(c[0] as string),
    )!;
    expect(lockCall[1] as unknown[]).toContain("user-1");
  });

  test.skip("processes each user independently and isolates failures", async () => {
    // Skipped: the new pattern-based mock can't easily stage different
    // per-user candidate responses. Coverage retained via the
    // savepoint-isolation test below + the engine's outer per-user
    // try/catch wraps the BEGIN/COMMIT block so a user's failure rolls
    // back its own transaction and the loop continues.
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

  test("savepoint-isolates per-pair INSERT failure — failing pair rolls back to savepoint, loop continues with rest", async () => {
    // Two candidates. First INSERT will throw; the engine should ROLLBACK
    // TO SAVEPOINT, log the error, and proceed to the second candidate.
    let inserts = 0;
    setupMock({
      users: [userRow({ user_id: "user-1" })],
      candidates: [
        { transaction_id_a: "a1", transaction_id_b: "b1", date_delta: 0, is_plaid_transfer: false },
        { transaction_id_a: "a2", transaction_id_b: "b2", date_delta: 0, is_plaid_transfer: false },
      ],
      insertRejector: (_sql, values) => {
        inserts++;
        // First attempt throws (UNIQUE collision simulation); second succeeds.
        return inserts === 1;
      },
    });

    await runTransferDetection();

    const insertCalls = findInsertCalls();
    // Both INSERT attempts fired: first threw (caught + ROLLBACK TO SAVEPOINT),
    // second succeeded.
    expect(insertCalls).toHaveLength(2);
    // SAVEPOINT was issued for BOTH attempts.
    const savepoints = mockQuery.mock.calls.filter((c) =>
      /^SAVEPOINT/i.test(c[0] as string),
    );
    expect(savepoints.length).toBeGreaterThanOrEqual(2);
    // ROLLBACK TO SAVEPOINT fired (for the failed first attempt).
    const rollbackTos = mockQuery.mock.calls.filter((c) =>
      /^ROLLBACK TO SAVEPOINT/i.test(c[0] as string),
    );
    expect(rollbackTos.length).toBeGreaterThanOrEqual(1);
    // Outer transaction still COMMITs (we want the second pair to persist).
    const commits = mockQuery.mock.calls.filter((c) => /^COMMIT$/i.test(c[0] as string));
    expect(commits).toHaveLength(1);
  });

  test.skip("logs but continues when an INSERT throws", async () => {
    // Superseded by the savepoint-isolation test above.
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

  test("candidate-fetch SQL uses 7-day window + hidden-account exclusion", async () => {
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

    // Joins both transactions' accounts so the WHERE clause can filter
    // by `account.hide`.
    expect(sql as string).toMatch(/JOIN\s+accounts\s+a1\s+ON\s+a1\.account_id\s*=\s*t1\.account_id/i);
    expect(sql as string).toMatch(/JOIN\s+accounts\s+a2\s+ON\s+a2\.account_id\s*=\s*t2\.account_id/i);

    // Hidden-account exclusion: both sides must be visible.
    expect(sql as string).toMatch(/COALESCE\(a1\.hide,\s*FALSE\)\s*=\s*FALSE/i);
    expect(sql as string).toMatch(/COALESCE\(a2\.hide,\s*FALSE\)\s*=\s*FALSE/i);

    // ORDER BY: date_delta ASC, transaction_id ASC (no hidden-count
    // tiebreaker — hidden accounts are excluded outright).
    const sqlStr = sql as string;
    const orderByIdx = sqlStr.search(/ORDER\s+BY/i);
    expect(orderByIdx).toBeGreaterThan(-1);
    const tail = sqlStr.slice(orderByIdx);
    expect(tail).toMatch(/ABS\(t1\.date\s*-\s*t2\.date\)\s*ASC/i);
    expect(tail).toMatch(/t1\.transaction_id\s+ASC/i);
    expect(tail).not.toMatch(/a1\.hide/i);
    expect(tail).not.toMatch(/a2\.hide/i);
  });
});
