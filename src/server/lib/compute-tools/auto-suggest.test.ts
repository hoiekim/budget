//
// `runAutoSuggestions` uses the multi-feature scoring engine. Every
// unlabeled transaction queries the user's confirmed history across
// seven features (merchant_name fuzzy, name fuzzy, amount band,
// payment_channel, account_id, plaid PFC, day-of-month band); a
// historical row's contribution is the count of features it matched.
// The function calls `usersTable.query`, `transactionsTable.query`,
// `pool.query` (feature signal + split fetch), and `Table.update` for
// both label-apply paths. The bundle inlines all of that; the test
// leaf-mocks `pg` so every SELECT/UPDATE lands on `mockQuery`.
//
// A SQL router dispatches each call by shape:
//   - `FROM users`                            → userRows
//   - `FROM transactions` (unlabeled fetch)   → unlabeledRows (per userId)
//   - `WITH scored AS` (feature signal)       → signalRow
//   - `FROM split_transactions`               → splitRows (per userId)
//   - `UPDATE transactions`/`split_transactions` → captured + return ok
import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";
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

const { runAutoSuggestions, CAS_NULL_CONFIDENCE } = await import("./auto\-suggest");

afterAll(restoreLeaves);
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

const isSignalSql = (sql: string) => /WITH\s+scored\s+AS/i.test(sql);

const queryRouter = async (sql: string, values?: unknown[]) => {
  const params = values ?? [];

  // Feature signal — recognized by the `WITH scored AS` CTE. Each call
  // gets the same staged `signalRow` (or empty if not staged) — tests
  // that exercise multiple unlabeled transactions stage one row that's
  // returned for every signal query. The actual scoring logic lives in
  // SQL; tests don't re-implement it here.
  if (isSignalSql(sql)) {
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
  mockQuery.mock.calls.filter((c) => isSignalSql(c[0] as string)).length;

describe("runAutoSuggestions", () => {
  test("skips when no users found", async () => {
    userRows = [];
    await runAutoSuggestions();
    expect(signalCalls()).toBe(0);
    expect(updateCalls(/UPDATE\s+transactions\b/i)).toHaveLength(0);
  });

  // The default txRow fixture has merchant_name="Coffee Shop", amount=5,
  // account_id="acc-1", payment_channel=null, raw=null. So max_per_row
  // for these targets = W_AMOUNT(5) + W_ACCOUNT(1) + W_DAY(1) +
  // W_MERCHANT_NAME(100) = 107. (name=null skips W_NAME; raw=null
  // skips W_PFC; payment_channel=null skips W_PAYMENT_CHANNEL.)
  // Tests below use signal rows whose accepted/count_matched values
  // produce known quality = accepted / (count_matched × 107).

  test("skips when count_matched < 3 (sample-size floor)", async () => {
    userRows = [userRow({ user_id: "user-1" })];
    unlabeledByUser.set("user-1", [
      txRow({ transaction_id: "txn-1", user_id: "user-1", merchant_name: "Coffee Shop" }),
    ]);
    // count_matched = 2 — below the floor of 3.
    signalRow = {
      label_category_id: "cat-1",
      label_budget_id: "bud-1",
      accepted: "200", // strong (avg 100/row) but count too low
      count_matched: "2",
      rejected: "0",
    };

    await runAutoSuggestions();

    expect(updateCalls(/UPDATE\s+transactions\b/i)).toHaveLength(0);
  });

  test("skips when reject rate > 0.1", async () => {
    userRows = [userRow({ user_id: "user-2" })];
    unlabeledByUser.set("user-2", [
      txRow({ transaction_id: "txn-2", user_id: "user-2", merchant_name: "Restaurant" }),
    ]);
    // 800 accepted vs 200 rejected → reject rate = 0.20 > 0.10 → skip.
    signalRow = {
      label_category_id: "cat-2",
      label_budget_id: "bud-2",
      accepted: "800",
      count_matched: "10",
      rejected: "200",
    };

    await runAutoSuggestions();

    expect(updateCalls(/UPDATE\s+transactions\b/i)).toHaveLength(0);
  });

  test("skips when quality < MIN_QUALITY (0.30)", async () => {
    userRows = [userRow({ user_id: "user-3" })];
    unlabeledByUser.set("user-3", [
      txRow({ transaction_id: "txn-3", user_id: "user-3", merchant_name: "Gas Station" }),
    ]);
    // 50 rows averaging score 30 each → quality = (50×30) / (50×107) ≈ 0.28
    // — below the 0.30 floor — skip.
    signalRow = {
      label_category_id: "cat-3",
      label_budget_id: "bud-3",
      accepted: "1500",
      count_matched: "50",
      rejected: "0",
    };

    await runAutoSuggestions();

    expect(updateCalls(/UPDATE\s+transactions\b/i)).toHaveLength(0);
  });

  test("applies suggestion with confidence = quality clamped to [0.5, 0.98]", async () => {
    userRows = [userRow({ user_id: "user-4" })];
    unlabeledByUser.set("user-4", [
      txRow({ transaction_id: "txn-4", user_id: "user-4", merchant_name: "Grocery Store" }),
    ]);
    // 10 rows averaging score 100 each (merchant-match) → quality = 1000/(10×107) ≈ 0.935
    // > 0.30 floor → apply. Stored confidence = quality (in band).
    signalRow = {
      label_category_id: "cat-groceries",
      label_budget_id: "bud-household",
      accepted: "1000",
      count_matched: "10",
      rejected: "0",
    };

    await runAutoSuggestions();

    const updates = updateCalls(/UPDATE\s+transactions\b/i);
    expect(updates).toHaveLength(1);
    expect(updates[0].values[0]).toBe("cat-groceries");
    expect(updates[0].values[1]).toBe("bud-household");
    const confidence = updates[0].values[2] as number;
    expect(confidence).toBeGreaterThan(0.5);
    expect(confidence).toBeLessThan(0.98);
    expect(confidence).toBeCloseTo(0.935, 2);
  });

  test("a perfect-match signal clamps stored confidence to the 0.98 ceiling", async () => {
    // Even at quality 1.0 (every row at max), the stored confidence
    // tops out at the ENGINE_CONFIDENCE_CEIL. The ceiling protects the
    // 0.99 reservation for `/api/suggest-category` and 1.0 for
    // user-confirmed labels.
    userRows = [userRow({ user_id: "user-5" })];
    unlabeledByUser.set("user-5", [
      txRow({ transaction_id: "txn-5", user_id: "user-5", merchant_name: "Bookstore" }),
    ]);
    signalRow = {
      label_category_id: "cat-books",
      label_budget_id: "bud-leisure",
      accepted: "10700", // 100 rows × 107 = perfect score → quality = 1.0
      count_matched: "100",
      rejected: "0",
    };

    await runAutoSuggestions();

    const updates = updateCalls(/UPDATE\s+transactions\b/i);
    expect(updates).toHaveLength(1);
    expect(updates[0].values[2]).toBe(0.98);
  });

  test("a borderline-quality signal clamps stored confidence to the 0.5 floor", async () => {
    // A signal that just barely passes the 0.30 quality gate would
    // produce a sub-0.5 stored confidence; the floor keeps the engine's
    // output inside the documented contract band.
    userRows = [userRow({ user_id: "user-6" })];
    unlabeledByUser.set("user-6", [
      txRow({ transaction_id: "txn-6", user_id: "user-6", merchant_name: "Borderline Inc" }),
    ]);
    // 4 rows averaging score ~32 each → quality = 128/(4×107) ≈ 0.299
    // ↑ would actually fail the gate; bump slightly above. 130/(4×107) ≈ 0.304
    signalRow = {
      label_category_id: "cat-borderline",
      label_budget_id: "bud-misc",
      accepted: "130",
      count_matched: "4",
      rejected: "0",
    };

    await runAutoSuggestions();

    const updates = updateCalls(/UPDATE\s+transactions\b/i);
    expect(updates).toHaveLength(1);
    expect(updates[0].values[2]).toBe(0.5);
  });

  test("each unlabeled transaction triggers its own signal query (no per-merchant cache)", async () => {
    // The multi-feature signal depends on the FULL feature set per
    // target. Two unlabeled rows that share merchant_name but differ in
    // amount / channel / account would (correctly) get different
    // signals. A cache by merchant alone would be wrong.
    userRows = [userRow({ user_id: "u-nocache" })];
    unlabeledByUser.set("u-nocache", [
      txRow({ transaction_id: "txn-1", user_id: "u-nocache", merchant_name: "Same Co", amount: 5 }),
      txRow({ transaction_id: "txn-2", user_id: "u-nocache", merchant_name: "Same Co", amount: 50 }),
    ]);
    signalRow = {
      label_category_id: "cat-x",
      label_budget_id: "bud-x",
      accepted: "500",
      count_matched: "5",
      rejected: "0",
    };

    await runAutoSuggestions();

    // Two unlabeled rows → two signal queries.
    expect(signalCalls()).toBe(2);
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
      // The fetchUnlabeledSplits SQL pulls merchant_name + name + amount +
      // payment_channel + account_id + raw + date from the parent join.
      {
        split_transaction_id: "split-1",
        merchant_name: "Grocery Store",
        name: "Whole Foods",
        amount: 25,
        payment_channel: "in store",
        account_id: "acc-1",
        raw: null,
        date: new Date().toISOString().slice(0, 10),
      },
    ]);
    signalRow = {
      label_category_id: "cat-groceries",
      label_budget_id: "bud-household",
      accepted: "1000",
      count_matched: "10",
      rejected: "0",
    };

    await runAutoSuggestions();

    const updates = updateCalls(/UPDATE\s+split_transactions\b/i);
    expect(updates).toHaveLength(1);
    expect(updates[0].values[0]).toBe("cat-groceries");
    expect(updates[0].values[1]).toBe("bud-household");
    // Split fixture has merchant_name="Grocery Store" + name="Whole Foods" so
    // max_per_row = W_AMOUNT(5) + W_ACCOUNT(1) + W_DAY(1) + W_MERCHANT(100) +
    // W_NAME(50) + W_CHANNEL(1) = 157. Note channel is set "in store".
    // Quality = 1000 / (10×157) ≈ 0.637. In-band → stored as-is.
    expect(updates[0].values[2]).toBeCloseTo(0.637, 2);
    expect(updates[0].values[3]).toBe("split-1");
    expect(updates[0].values[4]).toBe("user-split-1");
  });

  test("respects the gates on splits the same way as on transactions", async () => {
    // 8 accepted / 2 rejected → reject_rate = 0.2 > 0.1 → skip both passes.
    userRows = [userRow({ user_id: "user-gates" })];
    unlabeledByUser.set("user-gates", []);
    splitsByUser.set("user-gates", [
      {
        split_transaction_id: "split-1",
        merchant_name: "Skip Me",
        name: null,
        amount: 10,
        payment_channel: null,
        account_id: "acc-1",
        raw: null,
        date: new Date().toISOString().slice(0, 10),
      },
    ]);
    // 800 accepted / 200 rejected → reject rate 20% > 10% → skip both passes.
    signalRow = {
      label_category_id: "cat-y",
      label_budget_id: "bud-y",
      accepted: "800",
      count_matched: "10",
      rejected: "200",
    };

    await runAutoSuggestions();

    expect(updateCalls(/UPDATE\s+split_transactions\b/i)).toHaveLength(0);
  });

  // ──────────────────────────────────────────────────────────────────────
  // CAS guard against clobbering user-confirmed labels
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
        accepted: "1000",
        count_matched: "10",
        rejected: "0",
      };

      await runAutoSuggestions();

      const updates = updateCalls(/UPDATE\s+transactions\b/i);
      expect(updates).toHaveLength(1);
      expect(updates[0].sql).toContain("AND label_category_confidence IS NULL");
      expect(updates[0].values).toHaveLength(5);
    });

    test("applyLabelToSplit sends an UPDATE with the IS NULL CAS guard (end-to-end)", async () => {
      userRows = [userRow({ user_id: "user-cas2" })];
      unlabeledByUser.set("user-cas2", []);
      splitsByUser.set("user-cas2", [
        {
          split_transaction_id: "split-cas",
          merchant_name: "Some Merchant",
          name: null,
          amount: 10,
          payment_channel: null,
          account_id: "acc-1",
          raw: null,
          date: new Date().toISOString().slice(0, 10),
        },
      ]);
      signalRow = {
        label_category_id: "cat-cas",
        label_budget_id: "bud-cas",
        accepted: "1000",
        count_matched: "10",
        rejected: "0",
      };

      await runAutoSuggestions();

      const updates = updateCalls(/UPDATE\s+split_transactions\b/i);
      expect(updates).toHaveLength(1);
      expect(updates[0].sql).toContain("AND label_category_confidence IS NULL");
      expect(updates[0].values).toHaveLength(5);
    });

    test("auto-suggest.ts threads CAS_NULL_CONFIDENCE into both apply impls", () => {
      const src = readFileSync(join(import.meta.dir, "auto-suggest.ts"), "utf-8");
      const matches = src.match(/\[CAS_NULL_CONFIDENCE\]/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Multi-feature signal SQL shape
  // ──────────────────────────────────────────────────────────────────────

  describe("feature signal SQL shape", () => {
    const captureSignalSql = async () => {
      userRows = [userRow({ user_id: "u-shape" })];
      unlabeledByUser.set("u-shape", [
        txRow({
          transaction_id: "txn-shape",
          user_id: "u-shape",
          merchant_name: "Probe Co",
          name: "PROBE STORE 1234",
          amount: 12.34,
          payment_channel: "online",
          account_id: "acc-probe",
        }),
      ]);
      signalRow = {
        label_category_id: "cat-shape",
        label_budget_id: "bud-shape",
        accepted: "500",
        count_matched: "5",
        rejected: "0",
      };
      await runAutoSuggestions();
      const signalQuery = mockQuery.mock.calls.find((c) => isSignalSql(c[0] as string));
      expect(signalQuery).toBeDefined();
      return signalQuery![0] as string;
    };

    test("ACCEPTED is read from transactions WHERE label_category_confidence = 1.0 only", async () => {
      const sql = await captureSignalSql();
      expect(sql).toMatch(/label_category_confidence\s*=\s*1\.0/);
      expect(sql).not.toMatch(/label_category_confidence\s+IS NOT NULL/);
      expect(sql).not.toMatch(/label_category_confidence\s*=\s*0\.0/);
    });

    test("REJECTED is read from rejected_categories joined to transactions", async () => {
      const sql = await captureSignalSql();
      // The rejected subquery references the new table directly,
      // joins to `transactions`, and scopes by user_id on BOTH sides
      // (defense-in-depth against future schema changes that could
      // let a transaction_id appear under another user).
      expect(sql).toMatch(/FROM\s+rejected_categories\s+rc/);
      expect(sql).toMatch(
        /JOIN\s+transactions\s+t\s+ON\s+t\.transaction_id\s*=\s*rc\.transaction_id/,
      );
      expect(sql).toMatch(/rc\.user_id\s*=\s*\$1/);
      expect(sql).toMatch(/rc\.category_id\s*=\s*w\.label_category_id/);
    });

    test("score expression sums all seven feature CASE branches with per-feature weights", async () => {
      const sql = await captureSignalSql();
      // Seven features, each contributing its weight when matched.
      // Asserting the structural shape catches a refactor that
      // silently drops a feature OR flattens all weights to 1 (which
      // was the v1 design and got drowned by category volume). The
      // identity-like features (merchant/name/pfc) additionally gate
      // on `SIGN(amount) = SIGN($13)` — a separate test below pins
      // that specifically — so the `.*` between the threshold and the
      // weight tolerates the gate without re-asserting it here.
      expect(sql).toMatch(/similarity\(t\.merchant_name,\s*\$2\)\s*>=\s*\$3[\s\S]*?THEN\s+100\s+ELSE\s+0/);
      expect(sql).toMatch(/similarity\(t\.name,\s*\$4\)\s*>=\s*\$3[\s\S]*?THEN\s+50\s+ELSE\s+0/);
      expect(sql).toMatch(/t\.amount\s+BETWEEN\s+\$5\s+AND\s+\$6\s+THEN\s+5\s+ELSE\s+0/);
      expect(sql).toMatch(/t\.payment_channel\s*=\s*\$7\s+THEN\s+1\s+ELSE\s+0/);
      expect(sql).toMatch(/t\.account_id\s*=\s*\$8\s+THEN\s+1\s+ELSE\s+0/);
      expect(sql).toMatch(
        /personal_finance_category.+primary.+=\s*\$9[\s\S]*?THEN\s+10\s+ELSE\s+0/,
      );
      expect(sql).toMatch(
        /EXTRACT\(DAY\s+FROM\s+t\.date::date\)\s+BETWEEN\s+\$10\s+AND\s+\$11\s+THEN\s+1\s+ELSE\s+0/i,
      );
    });

    test("identity features (merchant/name/pfc) require sign(amount) to match the target's sign", async () => {
      const sql = await captureSignalSql();
      // Same merchant with opposite sign (a refund vs the underlying
      // purchase, a payout vs a payment) is much more likely a different
      // category than the same one. Gating the three identity-strength
      // features on `SIGN(t.amount) = SIGN($13::numeric)` prevents a
      // merchant-only match across signs from dominating the SUM. Weak
      // features (channel/account/day) stay unguarded; the amount-band
      // is already sign-preserving via the lo/hi computation.
      const signGate = /AND\s+SIGN\(t\.amount\)\s*=\s*SIGN\(\$13::numeric\)/g;
      const gates = sql.match(signGate) ?? [];
      // Three identity features × twice (accepted CTE + rejected
      // sub-query, both render SCORE_EXPR) = 6 occurrences minimum.
      expect(gates.length).toBeGreaterThanOrEqual(6);
    });

    test("merchant weight >> any single weak-feature weight (100 vs 1) so quality beats volume", async () => {
      const sql = await captureSignalSql();
      // Pin the relative weight ratio that makes the engine
      // discriminative. If someone "rebalances" the weights to be
      // closer (e.g. 5/3/2/1/1/2/1), broad-feature matches on
      // popular categories drown out narrow-feature matches on the
      // correct category. The 100x ratio between merchant and the
      // weak features (channel/account/day) is what guarantees this.
      const merchant = sql.match(/THEN\s+(\d+)\s+ELSE\s+0\s*END\)\s*$\s*\+\s*\(CASE WHEN \$4/m);
      const channel = sql.match(/payment_channel\s*=\s*\$7\s+THEN\s+(\d+)/);
      expect(merchant).toBeDefined();
      expect(channel).toBeDefined();
      const ratio = Number(merchant![1]) / Number(channel![1]);
      expect(ratio).toBeGreaterThanOrEqual(50);
    });

    test("score expression appears in BOTH accepted and rejected subqueries (symmetric scoring)", async () => {
      const sql = await captureSignalSql();
      // The exact SCORE expression is rendered into both the `scored`
      // CTE (for accepted scoring) and the rejected subquery — so the
      // gate compares two numbers computed by the same formula.
      const scoreFragments = sql.match(/similarity\(t\.merchant_name/g) ?? [];
      expect(scoreFragments.length).toBeGreaterThanOrEqual(2);
    });

    test("winning category is picked by SUM(score) DESC + COUNT(*) AS count_matched", async () => {
      const sql = await captureSignalSql();
      // Weighted SUM with a per-row threshold (score > $12) filters
      // out coincidental weak-only matches. COUNT(*) carries the
      // matched-row count out for the quality metric on the gate side.
      expect(sql).toMatch(/SUM\(score\)::int\s+AS\s+accepted/i);
      expect(sql).toMatch(/COUNT\(\*\)::int\s+AS\s+count_matched/i);
      expect(sql).toMatch(/ORDER\s+BY\s+accepted\s+DESC/i);
      expect(sql).toMatch(/WITH\s+scored\s+AS/i);
      expect(sql).toMatch(/WHERE\s+score\s*>\s*\$12/i);
      expect(sql).not.toMatch(/top_k\s+AS/i);
    });

    test("soft-deleted transactions are excluded from BOTH accepted and rejected counts", async () => {
      const sql = await captureSignalSql();
      const matches =
        sql.match(/is_deleted\s+IS\s+NULL\s+OR\s+(?:\w+\.)?is_deleted\s*=\s*FALSE/gi) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    test("optional features short-circuit to 0 when the target's value is null", async () => {
      const sql = await captureSignalSql();
      // Each of the four nullable features (merchant_name, name,
      // payment_channel, plaid_pfc) guards its CASE with a `$X::text
      // IS NOT NULL` predicate. Without this, NULL parameters would
      // make `similarity(...)` or `= NULL` always false but cost a
      // wasted index scan; worse, `payment_channel = NULL` returns
      // NULL (not false) and could leak into the SUM.
      const nullGuards = sql.match(/\$\d+::text\s+IS\s+NOT\s+NULL/gi) ?? [];
      expect(nullGuards.length).toBeGreaterThanOrEqual(4);
    });

    test("params array carries the target features in the documented slot order", async () => {
      userRows = [userRow({ user_id: "u-params" })];
      unlabeledByUser.set("u-params", [
        txRow({
          transaction_id: "txn-params",
          user_id: "u-params",
          merchant_name: "ACME CORP",
          name: "ACME STORE 99",
          amount: 100,
          payment_channel: "online",
          account_id: "acc-A",
          raw: { personal_finance_category: { primary: "FOOD_AND_DRINK" } },
        }),
      ]);
      signalRow = {
        label_category_id: "cat",
        label_budget_id: "bud",
        accepted: "5",
        rejected: "0",
      };
      await runAutoSuggestions();
      const call = mockQuery.mock.calls.find((c) => isSignalSql(c[0] as string));
      expect(call).toBeDefined();
      const values = (call![1] ?? []) as unknown[];
      // $1 = userId, $2 = merchant, $3 = sim threshold (0.5),
      // $4 = name, $5 = amount_lo, $6 = amount_hi,
      // $7 = payment_channel, $8 = account_id,
      // $9 = plaid_pfc_primary, $10 = day_lo, $11 = day_hi
      expect(values[0]).toBe("u-params");
      expect(values[1]).toBe("ACME CORP");
      expect(values[2]).toBe(0.5);
      expect(values[3]).toBe("ACME STORE 99");
      // amount_lo / amount_hi are sign-preserving ±20%.
      expect(values[4]).toBeCloseTo(80);
      expect(values[5]).toBeCloseTo(120);
      expect(values[6]).toBe("online");
      expect(values[7]).toBe("acc-A");
      expect(values[8]).toBe("FOOD_AND_DRINK");
      // day_lo / day_hi straddle the target's day-of-month by ±3.
      const day = new Date().getUTCDate();
      expect(values[9]).toBe(day - 3);
      expect(values[10]).toBe(day + 3);
      // $12 is the per-row score threshold (ROW_SCORE_THRESHOLD) —
      // a row only contributes to the SUM if its score exceeds this.
      expect(typeof values[11]).toBe("number");
      expect(values[11] as number).toBeGreaterThan(0);
      // $13 carries the target's raw amount — used as the sign source
      // for the merchant/name/pfc gates in SCORE_EXPR.
      expect(values[12]).toBe(100);
      // 13 params total.
      expect(values).toHaveLength(13);
    });
  });
});
