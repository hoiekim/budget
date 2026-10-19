import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakePg, restoreLeaves } from "test-helpers";

const { pg, mockQuery, mockClientQuery, resetQueryMocks } = createFakePg();

mock.module("pg", () => pg);

const { postRecurringRoute } = await import("./post-recurring");

afterAll(restoreLeaves);

beforeEach(() => {
  resetQueryMocks();
});

function makeReq(body: unknown) {
  return {
    method: "POST",
    path: "/recurrings",
    url: "http://x/api/recurrings",
    headers: {},
    query: {},
    body,
    session: {
      id: "s-1",
      user: { user_id: "u-1", username: "test" },
      regenerate() {},
      destroy() {},
    },
    ip: "127.0.0.1",
  } as unknown as Parameters<typeof postRecurringRoute.execute>[0];
}

const fakeRes = () =>
  ({
    statusCode: 200,
    headersSent: false,
    status() {
      return this;
    },
    write() {
      return true;
    },
    end() {},
  }) as unknown as Parameters<typeof postRecurringRoute.execute>[1];

const txnRow = (id: string) => ({
  transaction_id: id,
  user_id: "u-1",
  account_id: "acc-1",
  name: "NETFLIX.COM",
  merchant_name: "Netflix",
  amount: 15.99,
  iso_currency_code: "USD",
  date: "2026-10-02",
  pending: false,
  pending_transaction_id: null,
  payment_channel: "online",
  location_country: null,
  location_region: null,
  location_city: null,
  label_budget_id: null,
  label_category_id: null,
  label_memo: null,
  label_category_confidence: null,
  raw: null,
  updated: "2026-10-02T00:00:00Z",
  is_deleted: false,
  source: "plaid",
});

const recurringRow = (overrides: Record<string, unknown> = {}) => ({
  recurring_id: "r-1",
  user_id: "u-1",
  merchant_key: "netflix",
  merchant_name: "Netflix",
  cadence: "monthly",
  is_income: false,
  status: "confirmed",
  transaction_ids: ["t-1"],
  label_budget_id: null,
  label_category_id: null,
  splits: [],
  splits_since: null,
  created_at: "2026-10-02T00:00:00Z",
  updated: "2026-10-02T00:00:00Z",
  is_deleted: false,
  ...overrides,
});

describe("post-recurring — rename", () => {
  test("updates the name, trimmed and scoped to the session user", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ recurring_id: "r-1" }], rowCount: 1 });

    const result = await postRecurringRoute.execute(
      makeReq({ recurring_id: "r-1", merchant_name: "  Netflix Premium " }),
      fakeRes(),
    );

    expect(result?.status).toBe("success");
    expect(result?.body).toEqual({ recurring_id: "r-1" });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE recurrings/);
    expect(sql).toMatch(/merchant_name/);
    expect(sql).not.toMatch(/status/);
    expect(values).toContain("Netflix Premium");
    expect(values).toContain("r-1");
    expect(values).toContain("u-1");
  });

  test("refuses a blank name without touching the database", async () => {
    const result = await postRecurringRoute.execute(
      makeReq({ recurring_id: "r-1", merchant_name: "   " }),
      fakeRes(),
    );

    expect(result?.status).toBe("failed");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("reports a recurring that doesn't exist", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await postRecurringRoute.execute(
      makeReq({ recurring_id: "r-missing", merchant_name: "Netflix" }),
      fakeRes(),
    );

    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not found/);
  });
});

describe("post-recurring — create", () => {
  test("confirms on conflict, keeps a custom name, and answers with the recurring", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [txnRow("t-1")], rowCount: 1 }); // members
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // BEGIN
    mockClientQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 }); // advisory lock
    mockClientQuery.mockResolvedValueOnce({ rows: [{ transaction_id: "t-1" }], rowCount: 1 }); // existence
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // collision
    mockClientQuery.mockResolvedValueOnce({ rows: [{ recurring_id: "r-1" }], rowCount: 1 }); // upsert
    mockClientQuery.mockResolvedValueOnce({
      rows: [{ label_budget_id: null, label_category_id: null, transaction_ids: ["t-1"] }],
      rowCount: 1,
    }); // recurring's default label
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // seed: no labeled members
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT
    mockQuery.mockResolvedValueOnce({
      rows: [recurringRow({ merchant_name: "My Netflix" })],
      rowCount: 1,
    }); // read-back recurring
    mockQuery.mockResolvedValueOnce({ rows: [txnRow("t-1")], rowCount: 1 }); // read-back members

    const result = await postRecurringRoute.execute(
      makeReq({ transaction_ids: ["t-1"], merchant_name: "My Netflix" }),
      fakeRes(),
    );

    expect(result?.status).toBe("success");
    expect(result?.body?.recurring_id).toBe("r-1");
    expect(result?.body?.recurring?.merchant_name).toBe("My Netflix");
    expect(result?.body?.recurring?.status).toBe("confirmed");
    expect(result?.body?.recurring?.transactions.map((t) => t.transaction_id)).toEqual(["t-1"]);

    const upsert = mockClientQuery.mock.calls.find((c) => /INSERT INTO recurrings/.test(c[0] as string))!;
    expect(upsert[0] as string).toMatch(/status = 'confirmed'/);
    expect((upsert[1] as unknown[]).at(-1)).toBe(true);

    const readBack = mockQuery.mock.calls[1];
    expect(readBack[0] as string).toMatch(/FROM recurrings/);
    expect(readBack[1] as unknown[]).toContain("r-1");
  });
});

const B1 = "00000000-0000-0000-0000-0000000000b1";
const C1 = "00000000-0000-0000-0000-0000000000c1";
const B2 = "00000000-0000-0000-0000-0000000000b2";
const C2 = "00000000-0000-0000-0000-0000000000c2";

const clientSql = () => mockClientQuery.mock.calls.map((c) => c[0] as string);
const relabelCall = () =>
  mockClientQuery.mock.calls.find((c) => /UPDATE transactions/.test(c[0] as string));
const splitCall = () =>
  mockClientQuery.mock.calls.find((c) => /INSERT INTO split_transactions/.test(c[0] as string));
const squish = (sql: string) => sql.replace(/\s+/g, " ").trim();

describe("post-recurring — confirm", () => {
  test("confirms, seeds the default from the members, relabels them, and answers with the recurring", async () => {
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // BEGIN
    mockClientQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 }); // advisory lock
    mockClientQuery.mockResolvedValueOnce({ rows: [{ recurring_id: "r-1" }], rowCount: 1 }); // status
    mockClientQuery.mockResolvedValueOnce({
      rows: [{ label_budget_id: null, label_category_id: null, transaction_ids: ["t-1", "t-2"] }],
      rowCount: 1,
    }); // recurring's default label
    mockClientQuery.mockResolvedValueOnce({
      rows: [{ budget_id: B1, category_id: C1 }],
      rowCount: 1,
    }); // seed
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // store seeded default
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 2 }); // relabel members
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT
    mockQuery.mockResolvedValueOnce({
      rows: [recurringRow({ transaction_ids: ["t-1"], label_budget_id: B1, label_category_id: C1 })],
      rowCount: 1,
    }); // read-back recurring
    mockQuery.mockResolvedValueOnce({ rows: [txnRow("t-1")], rowCount: 1 }); // read-back members

    const result = await postRecurringRoute.execute(makeReq({ recurring_id: "r-1" }), fakeRes());

    expect(result?.status).toBe("success");
    expect(result?.body?.recurring?.label).toEqual({ budget_id: B1, category_id: C1 });
    expect(clientSql()[0]).toBe("BEGIN");
    expect(clientSql().at(-1)).toBe("COMMIT");
    expect(clientSql()[2]).toMatch(/SET status = 'confirmed'/);
    const [sql, values] = relabelCall()!;
    expect(sql as string).toMatch(/label_category_confidence IS NULL/);
    // Every member, the seeded default at confidence 1, and the seed as the
    // default they follow, so differently confirmed members stay put.
    expect(values).toEqual(["u-1", ["t-1", "t-2"], B1, C1, 1, B1, C1]);
  });

  test("relabels nothing when no member has a confirmed label to seed from", async () => {
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // BEGIN
    mockClientQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 }); // advisory lock
    mockClientQuery.mockResolvedValueOnce({ rows: [{ recurring_id: "r-1" }], rowCount: 1 }); // status
    mockClientQuery.mockResolvedValueOnce({
      rows: [{ label_budget_id: null, label_category_id: null, transaction_ids: ["t-1"] }],
      rowCount: 1,
    }); // recurring's default label
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // seed: nothing
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT
    mockQuery.mockResolvedValueOnce({ rows: [recurringRow()], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [txnRow("t-1")], rowCount: 1 });

    const result = await postRecurringRoute.execute(makeReq({ recurring_id: "r-1" }), fakeRes());

    expect(result?.status).toBe("success");
    expect(relabelCall()).toBeUndefined();
  });
});

describe("post-recurring — default label", () => {
  const stageLabel = (status: "confirmed" | "suggested") => {
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // BEGIN
    mockClientQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 }); // advisory lock
    mockClientQuery.mockResolvedValueOnce({
      rows: [
        { label_budget_id: B1, label_category_id: C1, status, transaction_ids: ["t-1", "t-2"] },
      ],
      rowCount: 1,
    }); // current default
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // store new default
    if (status === "confirmed") mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 2 });
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT
    mockQuery.mockResolvedValueOnce({
      rows: [recurringRow({ status, label_budget_id: B2, label_category_id: C2 })],
      rowCount: 1,
    });
    mockQuery.mockResolvedValueOnce({ rows: [txnRow("t-1")], rowCount: 1 });
  };

  test("confirmed: stores it and relabels members that followed the old default", async () => {
    stageLabel("confirmed");

    const result = await postRecurringRoute.execute(
      makeReq({ recurring_id: "r-1", label: { budget_id: B2, category_id: C2 } }),
      fakeRes(),
    );

    expect(result?.status).toBe("success");
    expect(result?.body?.recurring?.label).toEqual({ budget_id: B2, category_id: C2 });
    const store = mockClientQuery.mock.calls.find((c) =>
      /UPDATE recurrings\s+SET label_budget_id/.test(c[0] as string),
    )!;
    expect(store[1]).toEqual(["u-1", "r-1", B2, C2]);
    // The old default rides along so members that followed it move too.
    expect(relabelCall()![1]).toEqual(["u-1", ["t-1", "t-2"], B2, C2, 1, B1, C1]);
  });

  test("suggested: stores it without relabeling until it's confirmed", async () => {
    stageLabel("suggested");

    const result = await postRecurringRoute.execute(
      makeReq({ recurring_id: "r-1", label: { budget_id: B2, category_id: C2 } }),
      fakeRes(),
    );

    expect(result?.status).toBe("success");
    expect(relabelCall()).toBeUndefined();
  });

  test("a budget-only default marks the category empty on purpose, not unlabeled", async () => {
    stageLabel("confirmed");

    await postRecurringRoute.execute(
      makeReq({ recurring_id: "r-1", label: { budget_id: B2, category_id: null } }),
      fakeRes(),
    );

    // Confidence 0, not NULL: the suggestion engine only fills NULL rows.
    expect(relabelCall()![1]).toEqual(["u-1", ["t-1", "t-2"], B2, null, 0, B1, C1]);
  });

  test("with no stored default, members follow the label they're most often confirmed with", async () => {
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // BEGIN
    mockClientQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 }); // advisory lock
    mockClientQuery.mockResolvedValueOnce({
      rows: [
        {
          label_budget_id: null,
          label_category_id: null,
          status: "confirmed",
          transaction_ids: ["t-1", "t-2"],
        },
      ],
      rowCount: 1,
    }); // current default: none
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // store new default
    mockClientQuery.mockResolvedValueOnce({
      rows: [{ budget_id: B1, category_id: C1 }],
      rowCount: 1,
    }); // seed = the label they follow
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 2 }); // relabel
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT
    mockQuery.mockResolvedValueOnce({ rows: [recurringRow()], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [txnRow("t-1")], rowCount: 1 });

    await postRecurringRoute.execute(
      makeReq({ recurring_id: "r-1", label: { budget_id: B2, category_id: C2 } }),
      fakeRes(),
    );

    expect(relabelCall()![1]).toEqual(["u-1", ["t-1", "t-2"], B2, C2, 1, B1, C1]);
  });

  test("refuses ids that aren't UUIDs before touching the database", async () => {
    const result = await postRecurringRoute.execute(
      makeReq({ recurring_id: "r-1", label: { budget_id: "nope", category_id: null } }),
      fakeRes(),
    );

    expect(result?.status).toBe("failed");
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockClientQuery).not.toHaveBeenCalled();
  });
});

describe("post-recurring — add to existing", () => {
  test("a recurring with no default leaves joining charges' labels alone", async () => {
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // BEGIN
    mockClientQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 }); // advisory lock
    mockClientQuery.mockResolvedValueOnce({
      rows: [{ recurring_id: "r-1", is_income: false, status: "confirmed" }],
      rowCount: 1,
    }); // recurring
    mockClientQuery.mockResolvedValueOnce({
      rows: [{ transaction_id: "t-2", amount: "15.99" }],
      rowCount: 1,
    }); // members to add
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // collision
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // append
    mockClientQuery.mockResolvedValueOnce({
      rows: [{ label_budget_id: null, label_category_id: null, transaction_ids: ["t-1", "t-2"] }],
      rowCount: 1,
    }); // default: none (cleared)
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT
    mockQuery.mockResolvedValueOnce({ rows: [recurringRow({ transaction_ids: ["t-1", "t-2"] })], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [txnRow("t-1"), txnRow("t-2")], rowCount: 2 });

    const result = await postRecurringRoute.execute(
      makeReq({ recurring_id: "r-1", transaction_ids: ["t-2"] }),
      fakeRes(),
    );

    expect(result?.status).toBe("success");
    // No seeding and no relabel: a cleared default stays cleared.
    expect(clientSql().some((sql) => /GROUP BY label_budget_id/.test(sql))).toBe(false);
    expect(relabelCall()).toBeUndefined();
    expect(splitCall()).toBeUndefined();
    expect(clientSql().at(-1)).toBe("COMMIT");
  });

  test("joining charges are split by the recurring's default splits", async () => {
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // BEGIN
    mockClientQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 }); // advisory lock
    mockClientQuery.mockResolvedValueOnce({
      rows: [{ recurring_id: "r-1", is_income: false, status: "confirmed" }],
      rowCount: 1,
    }); // recurring
    mockClientQuery.mockResolvedValueOnce({
      rows: [{ transaction_id: "t-2", amount: "1200.00" }],
      rowCount: 1,
    }); // members to add
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // collision
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // append
    mockClientQuery.mockResolvedValueOnce({
      rows: [
        {
          label_budget_id: B1,
          label_category_id: C1,
          transaction_ids: ["t-1", "t-2"],
          splits: [
            { amount: 1000, label: { budget_id: B2, category_id: C2 } },
            { amount: 25.5, label: { budget_id: B2, category_id: null } },
          ],
          splits_since: "2026-09-15",
        },
      ],
      rowCount: 1,
    }); // default label and splits
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 2 }); // split
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // relabel
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT
    mockQuery.mockResolvedValueOnce({ rows: [recurringRow({ transaction_ids: ["t-1", "t-2"] })], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [txnRow("t-1"), txnRow("t-2")], rowCount: 2 });

    const result = await postRecurringRoute.execute(
      makeReq({ recurring_id: "r-1", transaction_ids: ["t-2"] }),
      fakeRes(),
    );

    expect(result?.status).toBe("success");
    const [sql, values] = splitCall()!;
    expect(squish(sql as string)).toBe(
      squish(`INSERT INTO split_transactions
         (user_id, transaction_id, account_id, amount, date,
          label_budget_id, label_category_id, label_category_confidence)
       SELECT t.user_id, t.transaction_id, t.account_id, s.amount * SIGN(t.amount), t.date,
              s.budget_id, s.category_id,
              CASE WHEN s.category_id IS NOT NULL THEN 1 WHEN s.budget_id IS NOT NULL THEN 0 END
       FROM transactions t
       CROSS JOIN UNNEST($3::numeric[], $4::uuid[], $5::uuid[]) AS s(amount, budget_id, category_id)
       WHERE t.user_id = $1
         AND t.transaction_id = ANY($2::text[])
         AND (t.is_deleted IS NULL OR t.is_deleted = FALSE)
         AND ABS(t.amount) > $6::numeric
         AND t.date >= $7::date
         AND NOT EXISTS (
           SELECT 1 FROM split_transactions x
           WHERE x.user_id = t.user_id
             AND x.transaction_id = t.transaction_id
             AND (x.is_deleted IS NULL OR x.is_deleted = FALSE)
         )`),
    );
    expect(values).toEqual(["u-1", ["t-2"], [1000, 25.5], [B2, B2], [C2, null], 1025.5, "2026-09-15"]);
    expect(relabelCall()![1]).toEqual(["u-1", ["t-2"], B1, C1, 1, B1, C1]);
    expect(clientSql().at(-1)).toBe("COMMIT");
  });

  test("confirming a recurring splits none of its members", async () => {
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // BEGIN
    mockClientQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 }); // advisory lock
    mockClientQuery.mockResolvedValueOnce({ rows: [{ recurring_id: "r-1" }], rowCount: 1 }); // status
    mockClientQuery.mockResolvedValueOnce({
      rows: [
        {
          label_budget_id: B1,
          label_category_id: C1,
          transaction_ids: ["t-1", "t-2"],
          splits: [{ amount: 1000, label: { budget_id: B2, category_id: C2 } }],
          splits_since: "2026-09-15",
        },
      ],
      rowCount: 1,
    }); // default label and splits
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 2 }); // relabel
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT
    mockQuery.mockResolvedValueOnce({ rows: [recurringRow()], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [txnRow("t-1")], rowCount: 1 });

    const result = await postRecurringRoute.execute(makeReq({ recurring_id: "r-1" }), fakeRes());

    expect(result?.status).toBe("success");
    expect(splitCall()).toBeUndefined();
    expect(relabelCall()).toBeDefined();
  });
});

const budgetRow = {
  user_id: "u-1",
  name: "Living",
  iso_currency_code: "USD",
  roll_over: false,
  roll_over_start_date: null,
  capacities: [],
  updated: "2026-10-02T00:00:00Z",
  is_deleted: false,
};
const categoryRow = {
  user_id: "u-1",
  section_id: "00000000-0000-0000-0000-0000000000a1",
  name: "Rent",
  roll_over: false,
  roll_over_start_date: null,
  capacities: [],
  updated: "2026-10-02T00:00:00Z",
  is_deleted: false,
};

describe("post-recurring — default splits", () => {
  const stageSplits = (stored: unknown[], { owned = true } = {}) => {
    if (owned) {
      mockQuery.mockResolvedValueOnce({ rows: [{ ...budgetRow, budget_id: B1 }], rowCount: 1 }); // owned budgets
      mockQuery.mockResolvedValueOnce({ rows: [{ ...categoryRow, category_id: C1 }], rowCount: 1 }); // owned categories
    }
    mockQuery.mockResolvedValueOnce({ rows: [{ recurring_id: "r-1" }], rowCount: 1 }); // store
    mockQuery.mockResolvedValueOnce({ rows: [recurringRow({ splits: stored })], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [txnRow("t-1")], rowCount: 1 });
  };
  const storeCall = () => mockQuery.mock.calls.find((c) => /UPDATE recurrings/.test(c[0] as string));

  test("stores them rounded to cents, from today, on a live recurring of the session user", async () => {
    const stored = [{ amount: 1000, label: { budget_id: B1, category_id: C1 } }];
    stageSplits(stored);

    const result = await postRecurringRoute.execute(
      makeReq({
        recurring_id: "r-1",
        splits: [
          { amount: 1000.004, label: { budget_id: B1, category_id: C1 } },
          { amount: 12.345, label: {} },
        ],
      }),
      fakeRes(),
    );

    expect(result?.status).toBe("success");
    expect(result?.body?.recurring?.splits).toEqual(stored);
    const [sql, values] = storeCall()!;
    expect(squish(sql as string)).toBe(
      squish(`UPDATE recurrings
       SET splits = $3::jsonb, splits_since = CURRENT_DATE, updated = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND recurring_id = $2
         AND (is_deleted IS NULL OR is_deleted = FALSE)
       RETURNING recurring_id`),
    );
    expect(values).toEqual([
      "u-1",
      "r-1",
      JSON.stringify([
        { amount: 1000, label: { budget_id: B1, category_id: C1 } },
        { amount: 12.35, label: { budget_id: null, category_id: null } },
      ]),
    ]);
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  test("refuses a label the user doesn't own without storing anything", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...budgetRow, budget_id: B1 }], rowCount: 1 }); // owned budgets
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // owned categories: none

    const result = await postRecurringRoute.execute(
      makeReq({ recurring_id: "r-1", splits: [{ amount: 10, label: { budget_id: B1, category_id: C2 } }] }),
      fakeRes(),
    );

    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not found/);
    expect(storeCall()).toBeUndefined();
    const [budgetSql, budgetValues] = mockQuery.mock.calls[0];
    expect(budgetSql as string).toMatch(/FROM budgets/);
    expect(budgetValues).toContain("u-1");
  });

  test("an empty list clears them", async () => {
    stageSplits([], { owned: false });

    const result = await postRecurringRoute.execute(
      makeReq({ recurring_id: "r-1", splits: [] }),
      fakeRes(),
    );

    expect(result?.status).toBe("success");
    expect(storeCall()![1]).toContain("[]");
  });

  test("reports a recurring that doesn't exist", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await postRecurringRoute.execute(
      makeReq({ recurring_id: "r-missing", splits: [] }),
      fakeRes(),
    );

    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not found/);
  });

  test.each([
    ["not an array", { amount: 10 }],
    ["a non-object split", [10]],
    ["a missing amount", [{ label: {} }]],
    ["a zero amount", [{ amount: 0.004 }]],
    ["a negative amount", [{ amount: -10 }]],
    ["a non-UUID label", [{ amount: 10, label: { budget_id: "nope" } }]],
    ["too many splits", Array.from({ length: 21 }, () => ({ amount: 1 }))],
  ])("refuses %s before touching the database", async (_, splits) => {
    const result = await postRecurringRoute.execute(
      makeReq({ recurring_id: "r-1", splits }),
      fakeRes(),
    );

    expect(result?.status).toBe("failed");
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockClientQuery).not.toHaveBeenCalled();
  });
});
