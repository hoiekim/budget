// Per-test-bundle isolation — see scripts/test-bundled/.
//
// `runAutoSuggestions` lost its six DI seams (queryFn / log / fetchUsers /
// fetchUnlabeled / applyLabel / fetchUnlabeledSplits / applyLabelToSplit).
// The function now calls `usersTable.query`, `transactionsTable.query`,
// `pool.query` (merchant signal + split fetch), and `Table.update` for
// both label-apply paths. The bundle inlines all of that; the test leaf-
// mocks `pg` so every SELECT/UPDATE lands on `mockQuery`.
//
// A SQL router dispatches each call by shape:
//   - `FROM users`                            → userRows
//   - `FROM transactions` (unlabeled fetch)   → unlabeledRows (per userId)
//   - `similarity(merchant_name`              → signalRow (merchant signal)
//   - `FROM split_transactions`               → splitRows (per userId)
//   - `UPDATE transactions`/`split_transactions` → captured + return ok
// @bundles src/server/lib/compute-tools/auto-suggest.ts
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

const { runAutoSuggestions, CAS_NULL_CONFIDENCE } = await import("./auto-suggest");
const { buildUpdate } = await import("../postgres/database");

/** Full TransactionModel-valid row. The Model constructor validates every
 *  field via `typeChecker`; missing or wrong-typed values throw. */
const txRow = (overrides: Record<string, unknown> = {}) => ({
  transaction_id: "txn-1",
  user_id: "u-1",
  account_id: "acc-1",
  name: null,
  merchant_name: "Coffee Shop",
  amount: 5,
  iso_currency_code: "USD",
  date: new Date().toISOString().slice(0, 10), // ISO YYYY-MM-DD (today)
  pending: false,
  pending_transaction_id: null,
  payment_channel: null,
  location_country: null,
  location_region: null,
  location_city: null,
  label_budget_id: null,
  label_category_id: null,
  label_memo: null,
  label_category_confidence: null,
  raw: null,
  updated: null,
  is_deleted: false,
  ...overrides,
});

/** Full UserModel-valid row. */
const userRow = (overrides: Record<string, unknown> = {}) => ({
  user_id: "u-1",
  username: "alice",
  password: null,
  email: null,
  expiry: null,
  token: null,
  updated: null,
  is_deleted: false,
  ...overrides,
});

/** Per-user staging — keyed by user_id (params[0] on the unlabeled SELECT). */
let userRows: Array<ReturnType<typeof userRow>> = [];
let unlabeledByUser: Map<string, Array<ReturnType<typeof txRow>>> = new Map();
let splitsByUser: Map<string, Array<Record<string, unknown>>> = new Map();
let signalRow: Record<string, string> | null = null;
let throwOnUnlabeledFor: Set<string> = new Set();

const queryRouter = async (sql: string, values?: unknown[]) => {
  const params = values ?? [];

  // Merchant signal (pg_trgm similarity + SUM(CASE WHEN ...)).
  if (/similarity\(merchant_name/i.test(sql)) {
    return signalRow ? { rows: [signalRow], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  // Split fetch (JOIN'd raw pool query).
  if (/FROM\s+split_transactions\b/i.test(sql)) {
    const userId = (params[0] as string) ?? "";
    const rows = splitsByUser.get(userId) ?? [];
    return { rows, rowCount: rows.length };
  }

  // Unlabeled transactions fetch via transactionsTable.query (SELECT * FROM transactions ...).
  if (/^\s*SELECT[\s\S]*FROM\s+transactions\b/i.test(sql)) {
    const userId = (params[0] as string) ?? "";
    if (throwOnUnlabeledFor.has(userId)) throw new Error(`fetchUnlabeled failed for ${userId}`);
    const rows = unlabeledByUser.get(userId) ?? [];
    return { rows, rowCount: rows.length };
  }

  // Users table SELECT (no user_id param).
  if (/^\s*SELECT[\s\S]*FROM\s+users\b/i.test(sql)) {
    return { rows: userRows, rowCount: userRows.length };
  }

  // Default — UPDATE/INSERT calls fall here. Tests inspect mockQuery.mock.calls.
  return { rows: [], rowCount: 0 };
};

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockImplementation(queryRouter);
  userRows = [];
  unlabeledByUser = new Map();
  splitsByUser = new Map();
  signalRow = null;
  throwOnUnlabeledFor = new Set();
});

const updateCalls = (target: RegExp): Array<{ sql: string; values: unknown[] }> =>
  mockQuery.mock.calls
    .map((c) => ({ sql: c[0] as string, values: (c[1] ?? []) as unknown[] }))
    .filter((c) => target.test(c.sql));

const signalCalls = (): number =>
  mockQuery.mock.calls.filter((c) => /similarity\(merchant_name/i.test(c[0] as string)).length;

describe("runAutoSuggestions", () => {
  test("skips when no users found", async () => {
    userRows = [];
    await runAutoSuggestions();
    expect(signalCalls()).toBe(0);
    expect(updateCalls(/UPDATE\s+transactions\b/i)).toHaveLength(0);
  });

  test("skips transaction when total_labeled < 3", async () => {
    userRows = [userRow({ user_id: "user-1" })];
    unlabeledByUser.set("user-1", [
      txRow({ transaction_id: "txn-1", user_id: "user-1", merchant_name: "Coffee Shop" }),
    ]);
    // Only 2 labeled — below threshold of 3.
    signalRow = { label_category_id: "cat-1", label_budget_id: "bud-1", accepted: "2", rejected: "0" };

    await runAutoSuggestions();

    expect(updateCalls(/UPDATE\s+transactions\b/i)).toHaveLength(0);
  });

  test("skips when reject_rate > 0.1", async () => {
    userRows = [userRow({ user_id: "user-2" })];
    unlabeledByUser.set("user-2", [
      txRow({ transaction_id: "txn-2", user_id: "user-2", merchant_name: "Restaurant" }),
    ]);
    // 8 accepted, 2 rejected → reject_rate = 0.2 > 0.1 → skip.
    signalRow = { label_category_id: "cat-2", label_budget_id: "bud-2", accepted: "8", rejected: "2" };

    await runAutoSuggestions();

    expect(updateCalls(/UPDATE\s+transactions\b/i)).toHaveLength(0);
  });

  test("skips when confidence < 0.95", async () => {
    userRows = [userRow({ user_id: "user-3" })];
    unlabeledByUser.set("user-3", [
      txRow({ transaction_id: "txn-3", user_id: "user-3", merchant_name: "Gas Station" }),
    ]);
    // 3 accepted, 1 rejected → confidence = 3/4 = 0.75 < 0.95 → skip.
    signalRow = { label_category_id: "cat-3", label_budget_id: "bud-3", accepted: "3", rejected: "1" };

    await runAutoSuggestions();

    expect(updateCalls(/UPDATE\s+transactions\b/i)).toHaveLength(0);
  });

  test("applies suggestion and caps confidence at 0.99", async () => {
    userRows = [userRow({ user_id: "user-4" })];
    unlabeledByUser.set("user-4", [
      txRow({ transaction_id: "txn-4", user_id: "user-4", merchant_name: "Grocery Store" }),
    ]);
    // 10 accepted, 0 rejected → confidence = 1.0 → caps at 0.99.
    signalRow = {
      label_category_id: "cat-groceries",
      label_budget_id: "bud-household",
      accepted: "10",
      rejected: "0",
    };

    await runAutoSuggestions();

    const updates = updateCalls(/UPDATE\s+transactions\b/i);
    expect(updates).toHaveLength(1);
    // buildUpdate emits "SET label_category_id = $1, label_budget_id = $2,
    // label_category_confidence = $3 WHERE transaction_id = $4 AND user_id = $5".
    // Confidence is the 3rd param.
    expect(updates[0].values[0]).toBe("cat-groceries");
    expect(updates[0].values[1]).toBe("bud-household");
    expect(updates[0].values[2]).toBe(0.99);
    expect(updates[0].values[3]).toBe("txn-4");
    expect(updates[0].values[4]).toBe("user-4");
  });

  test("computes exact confidence when ratio is between 0.95 and 0.99", async () => {
    userRows = [userRow({ user_id: "user-5" })];
    unlabeledByUser.set("user-5", [
      txRow({ transaction_id: "txn-5", user_id: "user-5", merchant_name: "Pharmacy" }),
    ]);
    // 19 accepted, 1 rejected → confidence = 19/20 = 0.95, reject_rate = 0.05.
    signalRow = {
      label_category_id: "cat-health",
      label_budget_id: "bud-medical",
      accepted: "19",
      rejected: "1",
    };

    await runAutoSuggestions();

    const updates = updateCalls(/UPDATE\s+transactions\b/i);
    expect(updates).toHaveLength(1);
    expect(updates[0].values[2] as number).toBeCloseTo(0.95, 5);
  });

  test("caches merchant signal — queries DB only once per unique merchant", async () => {
    userRows = [userRow({ user_id: "user-6" })];
    unlabeledByUser.set("user-6", [
      txRow({ transaction_id: "txn-6a", user_id: "user-6", merchant_name: "Bookstore" }),
      txRow({ transaction_id: "txn-6b", user_id: "user-6", merchant_name: "Bookstore" }),
    ]);
    signalRow = {
      label_category_id: "cat-books",
      label_budget_id: "bud-leisure",
      accepted: "5",
      rejected: "0",
    };

    await runAutoSuggestions();

    expect(signalCalls()).toBe(1);
  });

  test("uses pg_trgm similarity to fuzzy-match merchant_name variants", async () => {
    userRows = [userRow({ user_id: "user-7" })];
    unlabeledByUser.set("user-7", [
      txRow({ transaction_id: "txn-7", user_id: "user-7", merchant_name: "STARBUCKS #1234" }),
    ]);
    signalRow = {
      label_category_id: "cat-coffee",
      label_budget_id: "bud-discretionary",
      accepted: "5",
      rejected: "0",
    };

    await runAutoSuggestions();

    const signalQuery = mockQuery.mock.calls.find((c) =>
      /similarity\(merchant_name/i.test(c[0] as string),
    );
    expect(signalQuery).toBeDefined();
    const sql = signalQuery![0] as string;
    const params = (signalQuery![1] ?? []) as unknown[];
    expect(sql).toContain("similarity(merchant_name");
    expect(sql).not.toContain("merchant_name = $2");
    // Threshold and limit are passed as parameters, not interpolated.
    expect(params).toContain("STARBUCKS #1234");
    expect(params).toContain(0.5);
    expect(params).toContain(30);
  });

  test("continues processing other users when one fails", async () => {
    userRows = [userRow({ user_id: "fail-user" }), userRow({ user_id: "ok-user" })];
    throwOnUnlabeledFor.add("fail-user");
    unlabeledByUser.set("ok-user", []); // empty for ok-user; nothing to suggest

    await expect(runAutoSuggestions()).resolves.toBeUndefined();

    // Both users had their unlabeled SELECT attempted (the fail-user's threw,
    // the ok-user's resolved). The transactionsTable.query for ok-user must
    // be present in mockQuery.mock.calls — proves the loop continued.
    const txSelects = mockQuery.mock.calls.filter(
      (c) => /^\s*SELECT[\s\S]*FROM\s+transactions\b/i.test(c[0] as string),
    );
    const userIdsHit = txSelects.map((c) => (c[1] as unknown[])?.[0]);
    expect(userIdsHit).toContain("ok-user");
  });

  // ──────────────────────────────────────────────────────────────────────
  // Split-transactions pass (#334)
  // ──────────────────────────────────────────────────────────────────────

  test("applies suggestions to split transactions via the second pass", async () => {
    userRows = [userRow({ user_id: "user-split-1" })];
    unlabeledByUser.set("user-split-1", []); // no top-level transactions to score
    splitsByUser.set("user-split-1", [
      { split_transaction_id: "split-1", merchant_name: "Grocery Store" },
    ]);
    signalRow = {
      label_category_id: "cat-groceries",
      label_budget_id: "bud-household",
      accepted: "10",
      rejected: "0",
    };

    await runAutoSuggestions();

    const updates = updateCalls(/UPDATE\s+split_transactions\b/i);
    expect(updates).toHaveLength(1);
    expect(updates[0].values[0]).toBe("cat-groceries");
    expect(updates[0].values[1]).toBe("bud-household");
    expect(updates[0].values[2]).toBe(0.99);
    expect(updates[0].values[3]).toBe("split-1");
    expect(updates[0].values[4]).toBe("user-split-1");
  });

  test("reuses the merchant cache between transaction and split passes", async () => {
    // A parent transaction and a split share the same merchant_name. The
    // signal query should fire exactly once even though it's "needed" twice.
    userRows = [userRow({ user_id: "user-cache" })];
    unlabeledByUser.set("user-cache", [
      txRow({ transaction_id: "txn-1", user_id: "user-cache", merchant_name: "Same Merchant" }),
    ]);
    splitsByUser.set("user-cache", [
      { split_transaction_id: "split-1", merchant_name: "Same Merchant" },
    ]);
    signalRow = {
      label_category_id: "cat-x",
      label_budget_id: "bud-x",
      accepted: "5",
      rejected: "0",
    };

    await runAutoSuggestions();

    expect(signalCalls()).toBe(1);
  });

  test("respects the gates on splits the same way as on transactions", async () => {
    // 8 accepted / 2 rejected → reject_rate = 0.2 > 0.1 → skip both passes.
    userRows = [userRow({ user_id: "user-gates" })];
    unlabeledByUser.set("user-gates", []);
    splitsByUser.set("user-gates", [
      { split_transaction_id: "split-1", merchant_name: "Skip Me" },
    ]);
    signalRow = { label_category_id: "cat-y", label_budget_id: "bud-y", accepted: "8", rejected: "2" };

    await runAutoSuggestions();

    expect(updateCalls(/UPDATE\s+split_transactions\b/i)).toHaveLength(0);
  });

  // ──────────────────────────────────────────────────────────────────────
  // CAS guard against clobbering user-confirmed labels
  //
  // Verified against a non-scrambled prod-data sandbox on 2026-05-20:
  // a real `label_category_confidence = 1` row was successfully overwritten
  // to `0.99` by the exact SQL `transactionsTable.update` generated under
  // the pre-fix path (no IS-NULL guard). After the fix, `applyLabel` /
  // `applyLabelToSplit` pass `[CAS_NULL_CONFIDENCE]` through `Table.update`,
  // which `buildUpdate` translates to an explicit `AND
  // label_category_confidence IS NULL`. A confirmed row that flipped null →
  // 1.0 between the unlabeled fetch and the per-row apply is matched by
  // zero rows and the engine quietly skips it.
  //
  // With DI gone, every test in this file is end-to-end — the UPDATEs
  // above already pass through the real apply path. The two end-to-end
  // tests below pin the IS NULL clause explicitly so a refactor that
  // drops the guard fails loudly here, not just by silent regression
  // elsewhere.
  // ──────────────────────────────────────────────────────────────────────

  describe("CAS guard", () => {
    test("buildUpdate renders IS NULL when value is null in additionalWhere", () => {
      const query = buildUpdate(
        "transactions",
        "transaction_id",
        "txn-99",
        {
          label_category_id: "cat-99",
          label_budget_id: "bud-99",
          label_category_confidence: 0.97,
        },
        {
          additionalWhere: [
            { column: "user_id", value: "user-99" },
            { column: "label_category_confidence", value: null },
          ],
        },
      );
      expect(query).not.toBeNull();
      expect(query!.sql).toContain("WHERE transaction_id = $4");
      expect(query!.sql).toContain("AND user_id = $5");
      expect(query!.sql).toContain("AND label_category_confidence IS NULL");
      // The null guard must NOT consume a parameter slot — only userId does.
      expect(query!.values).toHaveLength(5);
      expect(query!.values[4]).toBe("user-99");
    });

    test("buildUpdate accepts a single object for additionalWhere (existing behavior preserved)", () => {
      const query = buildUpdate(
        "transactions",
        "transaction_id",
        "txn-99",
        { label_category_id: "cat-99" },
        { additionalWhere: { column: "user_id", value: "user-99" } },
      );
      expect(query).not.toBeNull();
      expect(query!.sql).toContain("WHERE transaction_id = $2");
      expect(query!.sql).toContain("AND user_id = $3");
      expect(query!.sql).not.toContain("IS NULL");
    });

    test("CAS_NULL_CONFIDENCE pins the column + null value the engine must always pass", () => {
      // Pin the literal shape. Anyone editing this constant has to also edit
      // this test, which forces a deliberate decision instead of a silent
      // refactor that drops the guard.
      expect(CAS_NULL_CONFIDENCE).toEqual({
        column: "label_category_confidence",
        value: null,
      });
    });

    test("applyLabel sends an UPDATE with the IS NULL CAS guard (end-to-end)", async () => {
      userRows = [userRow({ user_id: "user-cas" })];
      unlabeledByUser.set("user-cas", [
        txRow({ transaction_id: "txn-cas", user_id: "user-cas", merchant_name: "Some Merchant" }),
      ]);
      signalRow = {
        label_category_id: "cat-cas",
        label_budget_id: "bud-cas",
        accepted: "10",
        rejected: "0",
      };

      await runAutoSuggestions();

      const updates = updateCalls(/UPDATE\s+transactions\b/i);
      expect(updates).toHaveLength(1);
      expect(updates[0].sql).toContain("AND label_category_confidence IS NULL");
      // The guard must NOT consume a parameter slot. Engine arg count is 5
      // (cat, budget, confidence, txId, userId) — a 6th would mean buildUpdate
      // bound `null` as a placeholder param instead of rendering `IS NULL`.
      expect(updates[0].values).toHaveLength(5);
    });

    test("applyLabelToSplit sends an UPDATE with the IS NULL CAS guard (end-to-end)", async () => {
      userRows = [userRow({ user_id: "user-cas2" })];
      unlabeledByUser.set("user-cas2", []); // no top-level work
      splitsByUser.set("user-cas2", [
        { split_transaction_id: "split-cas", merchant_name: "Some Merchant" },
      ]);
      signalRow = {
        label_category_id: "cat-cas",
        label_budget_id: "bud-cas",
        accepted: "10",
        rejected: "0",
      };

      await runAutoSuggestions();

      const updates = updateCalls(/UPDATE\s+split_transactions\b/i);
      expect(updates).toHaveLength(1);
      expect(updates[0].sql).toContain("AND label_category_confidence IS NULL");
      expect(updates[0].values).toHaveLength(5);
    });

    // Source-level tripwire — catches the case where someone refactors the
    // apply paths to no longer reference `CAS_NULL_CONFIDENCE`. The end-to-
    // end tests above already cover the runtime semantics; this one catches
    // the earlier symptom of "removed the constant reference but happened to
    // keep behavior" so the next person reads the deliberate trail.
    test("auto-suggest.ts threads CAS_NULL_CONFIDENCE into both apply impls", () => {
      const src = readFileSync(join(import.meta.dir, "auto-suggest.ts"), "utf-8");
      const matches = src.match(/\[CAS_NULL_CONFIDENCE\]/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });
  });
});
