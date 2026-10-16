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
