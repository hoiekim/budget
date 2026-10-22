import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakePg, restoreLeaves } from "test-helpers";
import { TransactionPaymentChannelEnum } from "plaid";

const { pg, mockQuery, resetQueryMocks } = createFakePg();

mock.module("pg", () => pg);

const {
  searchTransactions,
  getTransaction,
  searchTransactionsById,
  searchTransactionsByAccountId,
  upsertTransactions,
  updateTransactions,
} = await import("./transactions");

afterAll(restoreLeaves);

function makeTxRow(overrides: Record<string, unknown> = {}) {
  return {
    transaction_id: "tx-1",
    user_id: "usr-1",
    account_id: "acc-1",
    name: "Coffee Shop",
    merchant_name: "Starbucks",
    amount: 5.5,
    iso_currency_code: "USD",
    date: "2026-03-01",
    pending: false,
    pending_transaction_id: null,
    payment_channel: TransactionPaymentChannelEnum.InStore,
    location_country: null,
    location_region: null,
    location_city: null,
    label_budget_id: null,
    label_category_id: null,
    label_memo: null,
    label_category_confidence: null,
    raw: null,
    updated: "2026-03-01T00:00:00Z",
    is_deleted: false,
    source: "plaid",
    ...overrides,
  };
}

const testUser = { user_id: "usr-1", username: "hoie" };

beforeEach(() => {
  resetQueryMocks();
});

const collect = async <T,>(batches: AsyncIterable<T[]>): Promise<T[]> => {
  const all: T[] = [];
  for await (const batch of batches) all.push(...batch);
  return all;
};

const queryAt = (i: number) => mockQuery.mock.calls[i] as [string, unknown[]];

describe("searchTransactions", () => {
  const readBoth = async (...args: Parameters<typeof searchTransactions>) => {
    const { transactions, investment_transactions } = searchTransactions(...args);
    return { transactions: await collect(transactions), investments: await collect(investment_transactions) };
  };

  test("returns mapped JSON transactions with nested labels", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          makeTxRow({ transaction_id: "tx-1", label_budget_id: "bud-1", label_memo: "work lunch" }),
          makeTxRow({ transaction_id: "tx-2" }),
        ],
        rowCount: 2,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const { transactions, investments } = await readBoth(testUser);

    expect(transactions.map((t) => t.transaction_id)).toEqual(["tx-1", "tx-2"]);
    expect(transactions[0].amount).toBe(5.5);
    expect(transactions[0].label.budget_id).toBe("bud-1");
    expect(transactions[0].label.memo).toBe("work lunch");
    expect(investments).toEqual([]);
  });

  test("scopes both the transactions and the investment transactions read to the user", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    await readBoth({ user_id: "usr-99", username: "test" });

    const [txSql, txValues] = queryAt(0);
    const [invSql, invValues] = queryAt(1);
    expect(txSql).toStartWith("SELECT * FROM transactions WHERE user_id = $1");
    expect(invSql).toStartWith("SELECT * FROM investment_transactions WHERE user_id = $1");
    expect(txValues[0]).toBe("usr-99");
    expect(invValues[0]).toBe("usr-99");
  });

  test("a delta read bounds rows by when they changed, not by their date", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    await readBoth(testUser, { startDate: "2026-10-01T00:00:00.000Z" });

    for (const i of [0, 1]) {
      const [sql, values] = queryAt(i);
      expect(sql).toContain("updated >= $");
      expect(sql).not.toMatch(/\bdate >= /);
      expect(values).toContain("2026-10-01T00:00:00.000Z");
    }
  });

  test("soft-deleted rows are included only when asked for, as tombstones", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    await readBoth(testUser, { includeDeleted: true });
    await readBoth(testUser);

    expect(queryAt(0)[0]).not.toContain("is_deleted");
    expect(queryAt(1)[0]).not.toContain("is_deleted");
    expect(queryAt(2)[0]).toContain("is_deleted");
    expect(queryAt(3)[0]).toContain("is_deleted");
  });

  test("narrows both reads to an account when one is given", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    await readBoth(testUser, { account_id: "acc-specific" });

    expect(queryAt(0)[1]).toContain("acc-specific");
    expect(queryAt(1)[1]).toContain("acc-specific");
  });

  test("nothing is queried until the batches are read", () => {
    searchTransactions(testUser);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("getTransaction", () => {
  test("returns transaction when found", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeTxRow({ transaction_id: "tx-abc" })],
      rowCount: 1,
    });
    const result = await getTransaction(testUser, "tx-abc");
    expect(result).not.toBeNull();
    expect(result?.transaction_id).toBe("tx-abc");
  });

  test("returns null when not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await getTransaction(testUser, "nonexistent");
    expect(result).toBeNull();
  });
});

describe("searchTransactionsById", () => {
  test("returns empty array for empty input", async () => {
    const result = await searchTransactionsById(testUser, []);
    expect(result).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("returns transactions for given ids", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeTxRow({ transaction_id: "tx-1" }), makeTxRow({ transaction_id: "tx-2" })],
      rowCount: 2,
    });
    const result = await searchTransactionsById(testUser, ["tx-1", "tx-2"]);
    expect(result).toHaveLength(2);
  });

  test("includes all ids in query values", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await searchTransactionsById(testUser, ["tx-x", "tx-y", "tx-z"]);
    const values = mockQuery.mock.calls[0][1] as string[];
    expect(values).toContain("tx-x");
    expect(values).toContain("tx-y");
    expect(values).toContain("tx-z");
  });
});

describe("searchTransactionsByAccountId", () => {
  test("defaults to active-only (excludeDeleted when includeDeleted unset)", async () => {
    // Two queries: one for transactions, one for investment_transactions.
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await searchTransactionsByAccountId(testUser, ["acc-1"]);
    const txSql = mockQuery.mock.calls[0][0] as string;
    const invSql = mockQuery.mock.calls[1][0] as string;
    expect(txSql).toContain("is_deleted IS NULL OR is_deleted = FALSE");
    expect(invSql).toContain("is_deleted IS NULL OR is_deleted = FALSE");
  });

  test("includeDeleted=true drops the soft-delete predicate on both arms", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await searchTransactionsByAccountId(testUser, ["acc-1"], undefined, {
      includeDeleted: true,
    });
    const txSql = mockQuery.mock.calls[0][0] as string;
    const invSql = mockQuery.mock.calls[1][0] as string;
    expect(txSql).not.toContain("is_deleted IS NULL OR is_deleted = FALSE");
    expect(invSql).not.toContain("is_deleted IS NULL OR is_deleted = FALSE");
  });

  test("returns is_deleted=true rows when includeDeleted=true", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeTxRow({ transaction_id: "tx-deleted", is_deleted: true })],
      rowCount: 1,
    });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await searchTransactionsByAccountId(testUser, ["acc-1"], undefined, {
      includeDeleted: true,
    });
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].transaction_id).toBe("tx-deleted");
    expect(result.transactions[0].is_deleted).toBe(true);
  });

  test("short-circuits on empty account_ids without touching the DB", async () => {
    const result = await searchTransactionsByAccountId(testUser, []);
    expect(result).toEqual({ transactions: [], investment_transactions: [] });
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("upsertTransactions", () => {
  test("returns empty array for empty input", async () => {
    const result = await upsertTransactions(testUser, []);
    expect(result).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("returns UpsertResult for each transaction", async () => {
    mockQuery.mockResolvedValue({ rows: [{ transaction_id: "tx-1" }], rowCount: 1 });
    const tx = {
      transaction_id: "tx-1",
      account_id: "acc-1",
      name: "Coffee",
      amount: 5.0,
      date: "2026-03-01",
      pending: false,
      merchant_name: null,
      iso_currency_code: "USD",
    } as Parameters<typeof upsertTransactions>[1][0];
    const result = await upsertTransactions(testUser, [tx]);
    expect(result).toHaveLength(1);
    expect(result[0].update._id).toBe("tx-1");
    expect(result[0].status).toBe(200);
  });

  test("returns error result on query failure", async () => {
    mockQuery.mockRejectedValueOnce(new Error("DB error"));
    const tx = {
      transaction_id: "tx-bad",
      account_id: "acc-1",
      name: "Failed",
      amount: 1.0,
      date: "2026-03-01",
      pending: false,
    } as Parameters<typeof upsertTransactions>[1][0];
    const result = await upsertTransactions(testUser, [tx]);
    expect(result[0].status).toBe(500);
    expect(result[0].update._id).toBe("tx-bad");
  });
});

describe("updateTransactions", () => {
  const OWNER = testUser.user_id;
  const budgetRow = (budget_id: string, user_id = OWNER) => ({
    budget_id,
    user_id,
    name: "b",
    iso_currency_code: "USD",
    roll_over: false,
    roll_over_start_date: null,
    capacities: [],
    updated: "2026-10-01T00:00:00.000Z",
    is_deleted: false,
  });
  const categoryRow = (category_id: string, user_id = OWNER) => ({
    category_id,
    user_id,
    section_id: "sec-1",
    name: "c",
    roll_over: false,
    roll_over_start_date: null,
    capacities: [],
    updated: "2026-10-01T00:00:00.000Z",
    is_deleted: false,
  });
  /** Each budget's and category's owner, by id; the lookups answer like their WHERE. */
  let budgets = new Map<string, string>();
  let categories = new Map<string, string>();
  let deleted = new Set<string>();
  const matching = (rows: Map<string, string>, sql: string, values: unknown[]) =>
    [...rows].filter(
      ([id, owner]) =>
        values.includes(id) &&
        (!/\buser_id\s*=/i.test(sql) || values.includes(owner)) &&
        (!/\bis_deleted\b/i.test(sql) || !deleted.has(id)),
    );
  const route = async (sql: string, values: unknown[] = []) => {
    if (/FROM\s+budgets\b/i.test(sql)) {
      const rows = matching(budgets, sql, values).map(([id, owner]) => budgetRow(id, owner));
      return { rows, rowCount: rows.length };
    }
    if (/FROM\s+categories\b/i.test(sql)) {
      const rows = matching(categories, sql, values).map(([id, owner]) => categoryRow(id, owner));
      return { rows, rowCount: rows.length };
    }
    return { rows: [{ transaction_id: "tx" }], rowCount: 1 };
  };
  const updateCall = () => mockQuery.mock.calls.find((c) => typeof c[0] === "string" && c[0].includes("UPDATE"));

  beforeEach(() => {
    budgets = new Map([["bud-1", OWNER], ["someone-elses-budget", "usr-2"]]);
    categories = new Map([["cat-1", OWNER], ["cat-2", OWNER], ["someone-elses-cat", "usr-2"]]);
    deleted = new Set();
    mockQuery.mockImplementation(route);
  });

  test("preserves caller-supplied category_confidence as-is (repo is pass-through)", async () => {
    const tx = {
      transaction_id: "tx-2",
      label: { category_id: "cat-2", category_confidence: 0.0 },
    } as Parameters<typeof updateTransactions>[1][0];
    await updateTransactions(testUser, [tx]);
    const values = updateCall()![1] as unknown[];
    expect(values).toContain(0.0);
    expect(values).not.toContain(1.0);
  });

  test("does not inject confidence when caller omits it (repo no longer infers)", async () => {
    const tx = {
      transaction_id: "tx-1",
      label: { category_id: "cat-1" },
    } as Parameters<typeof updateTransactions>[1][0];
    await updateTransactions(testUser, [tx]);
    const values = updateCall()![1] as unknown[];
    expect(values).not.toContain(1.0);
    expect(values).toContain("cat-1");
  });

  test("a label naming a category the caller doesn't own is refused, with no update", async () => {
    const tx = { transaction_id: "tx-3", label: { category_id: "someone-elses-cat" } } as Parameters<
      typeof updateTransactions
    >[1][0];
    expect(await updateTransactions(testUser, [tx])).toEqual([{ update: { _id: "tx-3" }, status: 422 }]);
    expect(updateCall()).toBeUndefined();
  });

  test("a label naming a budget the caller doesn't own is refused, with no update", async () => {
    const tx = { transaction_id: "tx-4", label: { budget_id: "someone-elses-budget" } } as Parameters<
      typeof updateTransactions
    >[1][0];
    expect(await updateTransactions(testUser, [tx])).toEqual([{ update: { _id: "tx-4" }, status: 422 }]);
    expect(updateCall()).toBeUndefined();
  });

  test("a label naming a budget or category that doesn't exist is refused, with no update", async () => {
    const txs = [
      { transaction_id: "tx-8", label: { category_id: "no-such-cat" } },
      { transaction_id: "tx-9", label: { budget_id: "no-such-budget" } },
    ] as Parameters<typeof updateTransactions>[1];
    expect(await updateTransactions(testUser, txs)).toEqual([
      { update: { _id: "tx-8" }, status: 422 },
      { update: { _id: "tx-9" }, status: 422 },
    ]);
    expect(updateCall()).toBeUndefined();
  });

  test("a label naming the caller's own budget and category is written", async () => {
    const tx = { transaction_id: "tx-5", label: { budget_id: "bud-1", category_id: "cat-1" } } as Parameters<
      typeof updateTransactions
    >[1][0];
    expect((await updateTransactions(testUser, [tx]))[0].status).toBe(200);
    expect(updateCall()![1]).toEqual(expect.arrayContaining(["bud-1", "cat-1"]));
  });

  test("a label naming the caller's own deleted budget and category is still written", async () => {
    deleted = new Set(["bud-1", "cat-1"]);
    const tx = { transaction_id: "tx-7", label: { budget_id: "bud-1", category_id: "cat-1" } } as Parameters<
      typeof updateTransactions
    >[1][0];
    expect((await updateTransactions(testUser, [tx]))[0].status).toBe(200);
    expect(updateCall()![1]).toEqual(expect.arrayContaining(["bud-1", "cat-1"]));
  });

  test("an update never moves a transaction to another account", async () => {
    const tx = { transaction_id: "tx-6", account_id: "someone-elses-account", name: "renamed" } as Parameters<
      typeof updateTransactions
    >[1][0];
    await updateTransactions(testUser, [tx]);
    const [sql, values] = updateCall()! as [string, unknown[]];
    expect(sql).not.toMatch(/\baccount_id\s*=/);
    expect(values).not.toContain("someone-elses-account");
    expect(values).toContain("renamed");
  });
});


