import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";
import { canonicalizePairIds } from "../models/transaction_pair";
import { TransactionPaymentChannelEnum } from "plaid";

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

const { getTransferPairs, pairTransactions, confirmTransferPair, rejectTransferPair } =
  await import("./transfers");

afterAll(restoreLeaves);

const mockUser = { user_id: "usr-1", username: "tester" } as { user_id: string; username: string };

function makePairRow(overrides: Record<string, unknown> = {}) {
  return {
    pair_id: "pair-1",
    user_id: "usr-1",
    transaction_id_a: "tx-1",
    transaction_id_b: "tx-2",
    status: "suggested",
    created_at: "2026-04-01T00:00:00Z",
    updated: "2026-04-01T00:00:00Z",
    is_deleted: false,
    ...overrides,
  };
}

function makeTxRow(overrides: Record<string, unknown> = {}) {
  return {
    transaction_id: "tx-1",
    user_id: "usr-1",
    account_id: "acc-1",
    name: "Transfer Out",
    merchant_name: null,
    amount: 100,
    iso_currency_code: "USD",
    date: "2026-04-01",
    pending: false,
    pending_transaction_id: null,
    payment_channel: TransactionPaymentChannelEnum.Other,
    location_country: null,
    location_region: null,
    location_city: null,
    label_budget_id: null,
    label_category_id: null,
    label_memo: null,
    label_category_confidence: null,
    raw: null,
    updated: "2026-04-01T00:00:00Z",
    is_deleted: false,
    source: "plaid",
    ...overrides,
  };
}

describe("getTransferPairs", () => {
  beforeEach(() => mockQuery.mockClear());

  test("returns empty array when no pairs exist (no transactions query issued)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await getTransferPairs(mockUser as never);
    expect(result).toEqual([]);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test("loads paired transactions and returns one entry per pair", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        makePairRow({
          pair_id: "pair-1",
          transaction_id_a: "tx-1",
          transaction_id_b: "tx-2",
          status: "confirmed",
        }),
      ],
      rowCount: 1,
    });
    mockQuery.mockResolvedValueOnce({
      rows: [makeTxRow({ transaction_id: "tx-1" }), makeTxRow({ transaction_id: "tx-2" })],
      rowCount: 2,
    });
    const result = await getTransferPairs(mockUser as never);
    expect(result).toHaveLength(1);
    expect(result[0].pair_id).toBe("pair-1");
    expect(result[0].status).toBe("confirmed");
    expect(result[0].transactions).toHaveLength(2);
  });

  test("drops a pair whose transactions are not retrievable (e.g. soft-deleted)", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        makePairRow({
          pair_id: "pair-1",
          transaction_id_a: "tx-1",
          transaction_id_b: "tx-MISSING",
        }),
      ],
      rowCount: 1,
    });
    mockQuery.mockResolvedValueOnce({
      rows: [makeTxRow({ transaction_id: "tx-1" })],
      rowCount: 1,
    });
    const result = await getTransferPairs(mockUser as never);
    expect(result).toEqual([]);
  });

  test("scopes both queries by user_id", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makePairRow()], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({
      rows: [makeTxRow({ transaction_id: "tx-1" }), makeTxRow({ transaction_id: "tx-2" })],
      rowCount: 2,
    });
    await getTransferPairs(mockUser as never);
    const [, pairValues] = mockQuery.mock.calls[0] as [string, unknown[]];
    const [, txValues] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(pairValues).toContain("usr-1");
    expect(txValues).toContain("usr-1");
  });
});

// Helpers for staging the response sequence of a `pairTransactions`
// transaction. Stages: BEGIN, advisory lock, existence pre-check (FOR
// SHARE), collision SELECT, INSERT, cleanup UPDATE, COMMIT (7 calls).
// On error path the existence/collision rejection replaces the
// INSERT+cleanup+COMMIT with a ROLLBACK.
function stagePairOk(insertPairId: string, collisionRows: unknown[] = []) {
  // BEGIN
  mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
  // advisory lock
  mockQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });
  // existence pre-check (FOR SHARE) — both alive: 2 rows
  mockQuery.mockResolvedValueOnce({
    rows: [{ transaction_id: "tx-a" }, { transaction_id: "tx-b" }],
    rowCount: 2,
  });
  // collision SELECT
  mockQuery.mockResolvedValueOnce({ rows: collisionRows, rowCount: collisionRows.length });
  // INSERT ... RETURNING
  mockQuery.mockResolvedValueOnce({
    rows: [{ pair_id: insertPairId }],
    rowCount: 1,
  });
  // cleanup UPDATE
  mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
  // COMMIT
  mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
}

function stagePairCollision(collidingPairId: string) {
  // BEGIN
  mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
  // advisory lock
  mockQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });
  // existence pre-check (FOR SHARE) — both alive: 2 rows
  mockQuery.mockResolvedValueOnce({
    rows: [{ transaction_id: "tx-a" }, { transaction_id: "tx-b" }],
    rowCount: 2,
  });
  // collision SELECT returns a colliding row → triggers ROLLBACK
  mockQuery.mockResolvedValueOnce({
    rows: [{ pair_id: collidingPairId }],
    rowCount: 1,
  });
  // ROLLBACK
  mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
}

function stagePairMissingTransaction(whichAlive: { a: boolean; b: boolean }) {
  // BEGIN
  mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
  // advisory lock
  mockQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });
  // existence pre-check (FOR SHARE) — at most one row if a transaction missing.
  const rows: { transaction_id: string }[] = [];
  if (whichAlive.a) rows.push({ transaction_id: "tx-a" });
  if (whichAlive.b) rows.push({ transaction_id: "tx-b" });
  mockQuery.mockResolvedValueOnce({ rows, rowCount: rows.length });
  // ROLLBACK
  mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
}

describe("pairTransactions", () => {
  beforeEach(() => mockQuery.mockClear());

  test("INSERTs into transaction_pairs and returns the effective pair_id", async () => {
    stagePairOk("pair-new");
    const result = await pairTransactions(mockUser as never, "tx-a", "tx-b");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pair_id).toBe("pair-new");
    // BEGIN + lock + existence + collision + INSERT + cleanup + COMMIT = 7 calls.
    expect(mockQuery).toHaveBeenCalledTimes(7);
    const insertCall = mockQuery.mock.calls.find((c) =>
      /INSERT INTO transaction_pairs/i.test(c[0] as string),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![1] as unknown[]).toContain("usr-1");
    expect(insertCall![1] as unknown[]).toContain("suggested");
  });

  test("uses ON CONFLICT (a, b) so a duplicate pair undeletes the existing row", async () => {
    stagePairOk("pair-existing");
    const result = await pairTransactions(mockUser as never, "tx-a", "tx-b");
    const insertCall = mockQuery.mock.calls.find((c) =>
      /INSERT INTO transaction_pairs/i.test(c[0] as string),
    )!;
    const sql = insertCall[0] as string;
    expect(sql).toContain("ON CONFLICT (transaction_id_a, transaction_id_b)");
    expect(sql).toContain("is_deleted = FALSE");
    expect(sql).toMatch(
      /CASE\s+WHEN\s+transaction_pairs\.is_deleted\s*=\s*TRUE\s+THEN\s+EXCLUDED\.status/,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pair_id).toBe("pair-existing");
  });

  test("canonicalizes (a, b) so reversed inputs hit the same row shape", async () => {
    stagePairOk("pair-1");
    await pairTransactions(mockUser as never, "tx-z", "tx-a");
    const insertCall = mockQuery.mock.calls.find((c) =>
      /INSERT INTO transaction_pairs/i.test(c[0] as string),
    )!;
    const values = insertCall[1] as unknown[];
    const idxA = values.indexOf("tx-a");
    const idxB = values.indexOf("tx-z");
    expect(idxA).toBeLessThan(idxB);
  });

  test("accepts confirmed status", async () => {
    stagePairOk("pair-1");
    await pairTransactions(mockUser as never, "tx-a", "tx-b", "confirmed");
    const insertCall = mockQuery.mock.calls.find((c) =>
      /INSERT INTO transaction_pairs/i.test(c[0] as string),
    )!;
    expect(insertCall[1] as unknown[]).toContain("confirmed");
  });

  test("rejects when transaction a is missing (soft-deleted or not user's)", async () => {
    stagePairMissingTransaction({ a: false, b: true });
    const result = await pairTransactions(mockUser as never, "tx-a", "tx-b");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/no longer exist/i);
    }
    // No INSERT should fire.
    expect(
      mockQuery.mock.calls.some((c) => /INSERT INTO transaction_pairs/i.test(c[0] as string)),
    ).toBe(false);
    // ROLLBACK fired.
    expect(mockQuery.mock.calls.some((c) => /^ROLLBACK$/i.test(c[0] as string))).toBe(true);
  });

  test("rejects when transaction b is missing", async () => {
    stagePairMissingTransaction({ a: true, b: false });
    const result = await pairTransactions(mockUser as never, "tx-a", "tx-b");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no longer exist/i);
    expect(
      mockQuery.mock.calls.some((c) => /INSERT INTO transaction_pairs/i.test(c[0] as string)),
    ).toBe(false);
  });

  test("rejects when one transaction is already in another active confirmed pair", async () => {
    stagePairCollision("pair-existing-confirmed");
    const result = await pairTransactions(mockUser as never, "tx-a", "tx-b");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/already in another confirmed transfer pair/i);
    }
    // BEGIN + lock + collision SELECT + ROLLBACK = 4 calls, no INSERT.
    const insertCalls = mockQuery.mock.calls.filter((c) =>
      /INSERT INTO transaction_pairs/i.test(c[0] as string),
    );
    expect(insertCalls).toHaveLength(0);
    // Transaction must have been rolled back, not silently dropped.
    const rolledBack = mockQuery.mock.calls.some((c) =>
      /^ROLLBACK$/i.test(c[0] as string),
    );
    expect(rolledBack).toBe(true);
    const committed = mockQuery.mock.calls.some((c) => /^COMMIT$/i.test(c[0] as string));
    expect(committed).toBe(false);
  });

  test("existence pre-check scopes by user_id, filters is_deleted, uses FOR SHARE", async () => {
    // Verify the existence query's SQL shape so a future refactor can't
    // silently drop the user_id filter (would allow cross-user pairing)
    // or drop FOR SHARE (would re-open the deleteTransactions race).
    stagePairOk("pair-new");
    await pairTransactions(mockUser as never, "tx-a", "tx-b");
    const existenceCall = mockQuery.mock.calls.find((c) => {
      const sql = c[0] as string;
      return /SELECT transaction_id FROM transactions/i.test(sql) && /FOR SHARE/i.test(sql);
    })!;
    expect(existenceCall).toBeDefined();
    const sql = existenceCall[0] as string;
    expect(sql).toMatch(/WHERE user_id = \$1/i);
    expect(sql).toMatch(/transaction_id = ANY\(\$2/i);
    expect(sql).toMatch(/is_deleted IS NULL OR is_deleted = FALSE/i);
    expect(sql).toMatch(/FOR SHARE/);
  });

  test("collision pre-check excludes the SAME (a, b) being re-paired (allows un-reject)", async () => {
    // Even if the SELECT matched the same (a, b) we're upserting, the WHERE
    // clause excludes that row via `NOT (transaction_id_a = $a AND ... = $b)`.
    // We verify the SQL shape.
    stagePairOk("pair-rejected-reactivated");
    await pairTransactions(mockUser as never, "tx-a", "tx-b");
    const collisionCall = mockQuery.mock.calls.find((c) =>
      /SELECT pair_id FROM transaction_pairs[\s\S]*status = 'confirmed'/i.test(c[0] as string),
    )!;
    expect(collisionCall[0] as string).toMatch(
      /NOT \(transaction_id_a = \$4 AND transaction_id_b = \$5\)/i,
    );
  });

  test("cleanup UPDATE flips other suggested pairs to status='rejected'", async () => {
    stagePairOk("pair-new");
    await pairTransactions(mockUser as never, "tx-a", "tx-b");
    const cleanupCall = mockQuery.mock.calls.find((c) => {
      const sql = c[0] as string;
      // Cleanup UPDATE: SET status='rejected' WHERE status='suggested'.
      // The WHERE filter scopes to 'suggested' (so existing rejected
      // rows stay rejected); the SET sets status='rejected'.
      return /UPDATE transaction_pairs[\s\S]*SET\s+status\s*=\s*'rejected'/i.test(sql)
        && /status = 'suggested'/i.test(sql);
    })!;
    expect(cleanupCall).toBeDefined();
    const sql = cleanupCall[0] as string;
    // Must scope to the user, exclude the just-created pair_id, and only
    // flip 'suggested' → 'rejected' (NOT touch 'rejected' / 'confirmed').
    expect(sql).toMatch(/pair_id <> \$2/);
    expect(sql).toMatch(/status = 'suggested'/);
    // The cleanup uses status='rejected', not is_deleted=TRUE. Soft-delete
    // is the SYSTEM cascade for removed transactions; rejection is the
    // persistent USER-intent denylist.
    expect(sql).not.toMatch(/is_deleted\s*=\s*TRUE/i);
  });
});

// Helpers for confirmTransferPair: BEGIN, advisory lock, lookup SELECT,
// collision SELECT, UPDATE confirmed, cleanup UPDATE, COMMIT (7 calls).
function stageConfirmOk(
  pairTxnA = "tx-a",
  pairTxnB = "tx-b",
  collisionRows: unknown[] = [],
) {
  // BEGIN
  mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
  // advisory lock
  mockQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });
  // lookup SELECT
  mockQuery.mockResolvedValueOnce({
    rows: [{ transaction_id_a: pairTxnA, transaction_id_b: pairTxnB }],
    rowCount: 1,
  });
  // collision SELECT
  mockQuery.mockResolvedValueOnce({
    rows: collisionRows,
    rowCount: collisionRows.length,
  });
  // UPDATE confirmed
  mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
  // cleanup UPDATE
  mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
  // COMMIT
  mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
}

function stageConfirmCollision(pairTxnA: string, pairTxnB: string) {
  // BEGIN
  mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
  // advisory lock
  mockQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });
  // lookup SELECT
  mockQuery.mockResolvedValueOnce({
    rows: [{ transaction_id_a: pairTxnA, transaction_id_b: pairTxnB }],
    rowCount: 1,
  });
  // collision SELECT returns a row → triggers ROLLBACK
  mockQuery.mockResolvedValueOnce({
    rows: [{ pair_id: "pair-colliding-confirmed" }],
    rowCount: 1,
  });
  // ROLLBACK
  mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
}

describe("confirmTransferPair", () => {
  beforeEach(() => mockQuery.mockClear());

  test("UPDATEs the pair row by pair_id with confirmed status", async () => {
    stageConfirmOk("tx-a", "tx-b");
    const result = await confirmTransferPair(mockUser as never, "pair-1");
    expect(result.ok).toBe(true);
    const updateCall = mockQuery.mock.calls.find((c) => {
      const sql = c[0] as string;
      return /UPDATE transaction_pairs/i.test(sql) && /'confirmed'/i.test(sql);
    })!;
    expect(updateCall).toBeDefined();
    expect(updateCall[1] as unknown[]).toContain("pair-1");
    expect(updateCall[1] as unknown[]).toContain("usr-1");
  });

  test("returns ok=false when pair not found", async () => {
    // BEGIN
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // advisory lock
    mockQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });
    // lookup SELECT returns no rows
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // ROLLBACK
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await confirmTransferPair(mockUser as never, "pair-missing");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not found/i);
    const updateCalls = mockQuery.mock.calls.filter((c) => {
      const sql = c[0] as string;
      return /UPDATE transaction_pairs/i.test(sql) && /'confirmed'/i.test(sql);
    });
    expect(updateCalls).toHaveLength(0);
    expect(mockQuery.mock.calls.some((c) => /^ROLLBACK$/i.test(c[0] as string))).toBe(true);
  });

  test("rejects when either transaction is already in another active confirmed pair", async () => {
    stageConfirmCollision("tx-a", "tx-b");
    const result = await confirmTransferPair(mockUser as never, "pair-1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/already in another confirmed transfer pair/i);
    }
    // No status UPDATE should fire.
    const updateCalls = mockQuery.mock.calls.filter((c) => {
      const sql = c[0] as string;
      return /UPDATE transaction_pairs/i.test(sql) && /'confirmed'/i.test(sql);
    });
    expect(updateCalls).toHaveLength(0);
    expect(mockQuery.mock.calls.some((c) => /^ROLLBACK$/i.test(c[0] as string))).toBe(true);
  });

  test("lookup SELECT excludes rejected pairs (status filter)", async () => {
    stageConfirmOk();
    await confirmTransferPair(mockUser as never, "pair-1");
    const lookupCall = mockQuery.mock.calls.find((c) => {
      const sql = c[0] as string;
      return /SELECT transaction_id_a, transaction_id_b FROM transaction_pairs/i.test(sql);
    })!;
    expect(lookupCall).toBeDefined();
    // The lookup must refuse to find a `status='rejected'` pair, so a
    // client can't directly POST a rejected pair_id to confirm it.
    expect(lookupCall[0] as string).toMatch(/status <> 'rejected'/i);
  });

  test("cleanup UPDATE flips other suggested pairs to status='rejected'", async () => {
    stageConfirmOk("tx-a", "tx-b");
    await confirmTransferPair(mockUser as never, "pair-1");
    const cleanupCall = mockQuery.mock.calls.find((c) => {
      const sql = c[0] as string;
      return /UPDATE transaction_pairs[\s\S]*SET\s+status\s*=\s*'rejected'/i.test(sql)
        && /status = 'suggested'/i.test(sql);
    })!;
    expect(cleanupCall).toBeDefined();
    const sql = cleanupCall[0] as string;
    expect(sql).toMatch(/pair_id <> \$2/);
    expect(sql).toMatch(/status = 'suggested'/);
    expect(sql).not.toMatch(/is_deleted\s*=\s*TRUE/i);
  });
});

describe("rejectTransferPair", () => {
  beforeEach(() => mockQuery.mockClear());

  test("sets status='rejected' on the pair row (keeps is_deleted=FALSE)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await rejectTransferPair(mockUser as never, "pair-1");
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("UPDATE transaction_pairs");
    expect(sql).toContain("status = 'rejected'");
    // Must NOT soft-delete — rejection and deletion are distinct.
    expect(sql).not.toContain("is_deleted = TRUE");
    // WHERE clause still excludes already-soft-deleted rows (no point
    // updating a tombstoned pair).
    expect(sql).toMatch(/is_deleted IS NULL OR is_deleted = FALSE/i);
    expect(values).toContain("pair-1");
    expect(values).toContain("usr-1");
  });
});

describe("canonicalizePairIds", () => {
  test("returns lexicographically smaller id as a", () => {
    expect(canonicalizePairIds("z", "a")).toEqual({
      transaction_id_a: "a",
      transaction_id_b: "z",
    });
    expect(canonicalizePairIds("a", "z")).toEqual({
      transaction_id_a: "a",
      transaction_id_b: "z",
    });
  });
});
