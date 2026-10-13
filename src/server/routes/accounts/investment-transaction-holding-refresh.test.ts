import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakePg, restoreLeaves } from "test-helpers";

// Editing or deleting an investment transaction refreshes the holding's
// derived positions, but only for a holding the engine already manages.

type Row = Record<string, unknown>;

const db = { snapshotIds: [] as string[], holdings: [] as Row[] };

const TRANSACTION: Row = {
  investment_transaction_id: "plan-row",
  user_id: "usr-1",
  account_id: "acct-1",
  security_id: "sec-1",
  date: "2026-03-02",
  name: "Buy (contribution)",
  amount: 100,
  quantity: 2,
  price: 50,
  iso_currency_code: "USD",
  type: "buy",
  subtype: "contribution",
  label_budget_id: null,
  label_category_id: null,
  label_memo: null,
  raw: null,
  updated: null,
  is_deleted: false,
  source: "manual",
};

const snapshotRow = (snapshot_id: string): Row => ({
  snapshot_id,
  user_id: "usr-1",
  snapshot_date: "2026-03-02T12:00:00.000Z",
  snapshot_type: "holding",
  account_id: null,
  balances_available: null,
  balances_current: null,
  balances_limit: null,
  balances_iso_currency_code: null,
  security_id: null,
  close_price: null,
  holding_account_id: "acct-1",
  holding_security_id: "sec-1",
  institution_price: 50,
  institution_value: 100,
  cost_basis: 100,
  quantity: 2,
  updated: null,
  is_deleted: false,
});

const { pg, mockQuery, mockClientQuery, clearQueryMocks } = createFakePg(async (sql: string) => {
  const rows = (() => {
    if (/^\s*UPDATE investment_transactions/i.test(sql)) return [{ investment_transaction_id: "plan-row" }];
    if (/FROM investment_transactions\b.*investment_transaction_id = /is.test(sql)) return [TRANSACTION];
    if (/FROM snapshots\b/i.test(sql)) return db.snapshotIds.map(snapshotRow);
    if (/FROM holdings\b/i.test(sql)) return db.holdings;
    return [];
  })();
  return { rows: rows as unknown[], rowCount: rows.length };
});

mock.module("pg", () => pg);

const { deleteInvestmentTransactionRoute } = await import("./delete-investment-transaction");
const { derivedSnapshotId } = await import("server");
const { postInvestmentTransactionRoute } = await import("./post-investment-transaction");

afterAll(restoreLeaves);

beforeEach(() => {
  clearQueryMocks();
  db.snapshotIds = [];
  db.holdings = [];
});

const req = (method: string, body: unknown, query: Record<string, string> = {}) =>
  ({
    method,
    path: "/investment-transaction",
    url: "http://x/api/investment-transaction",
    headers: {},
    query,
    body,
    session: { user: { user_id: "usr-1", username: "tester" } },
  }) as never;

const engineRan = () =>
  mockClientQuery.mock.calls.some(([sql]) => /FROM investment_transactions\b.*FOR UPDATE$/is.test(String(sql)));

describe("refreshing holding positions after a transaction changes", () => {
  test("deleting a row on a holding with derived snapshots refreshes it", async () => {
    db.snapshotIds = ["derived-holding-acct-1-sec-1-20260302-abcdef012345"];
    const res = await deleteInvestmentTransactionRoute.callback(req("DELETE", undefined, { id: "plan-row" }), {} as never, () => {});
    expect(res).toMatchObject({ status: "success" });
    const sql = mockClientQuery.mock.calls.map(([q]) => String(q));
    expect(sql[0]).toBe("BEGIN");
    expect(sql[1]).toContain("pg_advisory_xact_lock");
    expect(engineRan()).toBe(true);
    expect(sql.at(-1)).toBe("COMMIT");
  });

  test("deleting a row on an ordinary manual holding doesn't start deriving it", async () => {
    db.snapshotIds = ["holding-acct-1-sec-1-20260302"];
    await deleteInvestmentTransactionRoute.callback(req("DELETE", undefined, { id: "plan-row" }), {} as never, () => {});
    expect(engineRan()).toBe(false);
    expect(mockClientQuery.mock.calls.some(([q]) => /INSERT INTO (snapshots|holdings)/.test(String(q)))).toBe(false);
  });

  test("editing a position field refreshes a managed holding", async () => {
    db.snapshotIds = ["derived-holding-acct-1-sec-1-20260302-abcdef012345"];
    const res = await postInvestmentTransactionRoute.callback(
      req("POST", { investment_transaction_id: "plan-row", quantity: 3 }),
      {} as never,
      () => {},
    );
    expect(res).toMatchObject({ status: "success" });
    expect(engineRan()).toBe(true);
  });

  test("deleting a holding's last movement empties its holdings row", async () => {
    // A real derived snapshot, as the engine wrote it for the deleted buy.
    db.snapshotIds = [derivedSnapshotId("acct-1", "sec-1", "2026-03-02", { quantity: 2, costBasis: 100, price: 50 })];
    db.holdings = [
      {
        holding_id: "acct-1-sec-1",
        user_id: "usr-1",
        account_id: "acct-1",
        security_id: "sec-1",
        institution_price: 50,
        institution_price_as_of: "2026-03-02",
        institution_value: 100,
        cost_basis: 100,
        quantity: 2,
        iso_currency_code: null,
        raw: null,
        updated: null,
        is_deleted: false,
      },
    ];
    await deleteInvestmentTransactionRoute.callback(req("DELETE", undefined, { id: "plan-row" }), {} as never, () => {});
    const holding = mockClientQuery.mock.calls.find(([q]) => String(q).includes("INSERT INTO holdings"));
    expect(holding).toBeDefined();
    expect(holding![1]).toContain(0);
    expect(holding![1]).not.toContain(2);
  });

  test("moving a row to another fund refreshes both funds", async () => {
    db.snapshotIds = ["derived-holding-acct-1-sec-1-20260302-abcdef012345"];
    await postInvestmentTransactionRoute.callback(
      req("POST", { investment_transaction_id: "plan-row", security_id: "sec-2" }),
      {} as never,
      () => {},
    );
    const read = mockClientQuery.mock.calls.find(([q]) => /FROM snapshots\b/i.test(String(q)));
    expect(read![1]).toEqual(expect.arrayContaining(["sec-1", "sec-2"]));
  });

  test("editing a row's date refreshes the holding", async () => {
    db.snapshotIds = ["derived-holding-acct-1-sec-1-20260302-abcdef012345"];
    await postInvestmentTransactionRoute.callback(
      req("POST", { investment_transaction_id: "plan-row", date: "2026-03-03" }),
      {} as never,
      () => {},
    );
    expect(engineRan()).toBe(true);
  });

  test("editing only the memo leaves holdings alone", async () => {
    db.snapshotIds = ["derived-holding-acct-1-sec-1-20260302-abcdef012345"];
    await postInvestmentTransactionRoute.callback(
      req("POST", { investment_transaction_id: "plan-row", label: { memo: "note" } }),
      {} as never,
      () => {},
    );
    expect(mockClientQuery).not.toHaveBeenCalled();
    expect(mockQuery.mock.calls.some(([q]) => /FROM snapshots/.test(String(q)))).toBe(false);
  });
});
