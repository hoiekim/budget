import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakePg, restoreLeaves, updateColumnsOf } from "test-helpers";

type Row = Record<string, unknown>;

const db = {
  provider: "manual" as string,
  accountType: "investment" as string,
  existingIds: [] as string[],
};

const ACCOUNT: Row = {
  account_id: "acct-1",
  user_id: "usr-1",
  item_id: "item-1",
  institution_id: "manual",
  name: "Plan",
  type: "investment",
  subtype: null,
  balances_available: null,
  balances_current: null,
  balances_limit: null,
  balances_iso_currency_code: "USD",
  custom_name: null,
  hide: false,
  archived: false,
  label_budget_id: null,
  graph_options_use_snapshots: true,
  graph_options_use_holding_snapshots: true,
  graph_options_use_transactions: true,
  raw: null,
  updated: null,
  is_deleted: false,
};

const respond = async (sql: string): Promise<Row[]> => {
  if (/FROM accounts\b/i.test(sql)) return [{ ...ACCOUNT, type: db.accountType }];
  if (/FROM items\b/i.test(sql)) {
    return [
      {
        item_id: "item-1",
        user_id: "usr-1",
        access_token: null,
        institution_id: null,
        available_products: null,
        cursor: null,
        status: null,
        status_reason: null,
        provider: db.provider,
        last_sync_status: null,
        last_sync_at: null,
        last_sync_error: null,
        raw: null,
        updated: null,
        is_deleted: false,
      },
    ];
  }
  if (/FROM securities\b/i.test(sql)) {
    return [
      {
        security_id: "sec-index",
        name: "Index",
        ticker_symbol: "XIDX",
        type: null,
        close_price: null,
        close_price_as_of: null,
        iso_currency_code: "USD",
        isin: null,
        cusip: null,
        raw: null,
        updated: null,
      },
    ];
  }
  if (/FROM investment_transactions\b.*investment_transaction_id IN/is.test(sql)) {
    // Every existing row here is soft-deleted, as Postgres would filter it.
    if (/is_deleted = FALSE/.test(sql)) return [];
    return db.existingIds.map((id) => ({
      investment_transaction_id: id,
      user_id: "usr-1",
      account_id: "acct-1",
      security_id: null,
      date: "2026-03-02",
      name: null,
      amount: 0,
      quantity: 0,
      price: 0,
      iso_currency_code: null,
      type: "cash",
      subtype: null,
      label_budget_id: null,
      label_category_id: null,
      label_memo: null,
      raw: null,
      updated: null,
      is_deleted: true,
      source: "manual",
    }));
  }
  return [];
};

const { pg, mockQuery, mockClientQuery, clearQueryMocks } = createFakePg(async (sql: string) => {
  const rows = await respond(sql);
  return { rows: rows as unknown[], rowCount: rows.length };
});

mock.module("pg", () => pg);

const { postPlanStatementPreviewRoute, postPlanStatementImportRoute } = await import("./post-plan-statement");
const { getRowIds, parsePlanStatement } = await import("server");

afterAll(restoreLeaves);

const CSV = [
  "Plan name:,EXAMPLE PLAN",
  "Date,Investment,Transaction Type,Amount,Shares/Unit",
  '03/02/2026,EXAMPLE INDEX FUND,Contributions,"1,000.00","20.000"',
].join("\n");

const MAPPINGS = [{ investment: "EXAMPLE INDEX FUND", security_id: "sec-index", restated: false }];

const makeReq = (path: string, body: unknown, userId: string | null = "usr-1") =>
  ({
    method: "POST",
    path,
    url: `http://x/api${path}`,
    body,
    query: {},
    headers: {},
    session: userId ? { user: { user_id: userId, username: "tester" } } : {},
  }) as never;

const writes = () =>
  [...mockQuery.mock.calls, ...mockClientQuery.mock.calls]
    .map(([sql]) => String(sql))
    .filter((sql) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql));

beforeEach(() => {
  clearQueryMocks();
  db.provider = "manual";
  db.accountType = "investment";
  db.existingIds = [];
});

describe("POST /plan-statement/preview", () => {
  test("lists the rows it would write and writes nothing", async () => {
    const res = await postPlanStatementPreviewRoute.callback(
      makeReq("/plan-statement/preview", { account_id: "acct-1", csv: CSV, mappings: MAPPINGS }),
      {} as never, () => {},
    );
    expect(res).toMatchObject({ status: "success" });
    const body = (res as { body: { rows: { status: string }[]; blockers: string[] } }).body;
    expect(body.rows.map((r) => r.status)).toEqual(["new"]);
    expect(body.blockers).toEqual([]);
    expect(writes()).toEqual([]);
  });

  test("a soft-deleted row counts as already imported, so a removed row isn't brought back", async () => {
    db.existingIds = getRowIds("acct-1", parsePlanStatement(CSV).rows);
    const res = await postPlanStatementPreviewRoute.callback(
      makeReq("/plan-statement/preview", { account_id: "acct-1", csv: CSV, mappings: MAPPINGS }),
      {} as never, () => {},
    );
    const body = (res as { body: { rows: { status: string }[] } }).body;
    expect(body.rows.map((r) => r.status)).toEqual(["imported"]);
  });

  test("refuses an account that isn't a manual investment account", async () => {
    db.provider = "plaid";
    const res = await postPlanStatementPreviewRoute.callback(
      makeReq("/plan-statement/preview", { account_id: "acct-1", csv: CSV }),
      {} as never, () => {},
    );
    expect(res).toMatchObject({ status: "failed" });
    expect((res as { message: string }).message).toContain("manual investment account");
  });

  test.each([
    [{ account_id: "acct-1" }, "csv"],
    [{ account_id: "acct-1", csv: CSV, mappings: [{ investment: "X", security_id: "s", restated: "yes" }] }, "restated"],
    [{ account_id: "acct-1", csv: CSV, decisions: { "plan-1": "sell everything" } }, "unknown decision"],
  ])("rejects a malformed body %#", async (body, fragment) => {
    const res = await postPlanStatementPreviewRoute.callback(makeReq("/plan-statement/preview", body), {} as never, () => {});
    expect(res).toMatchObject({ status: "failed" });
    expect(JSON.stringify(res)).toContain(fragment);
  });

  test("requires a signed-in user", async () => {
    const res = await postPlanStatementPreviewRoute.callback(
      makeReq("/plan-statement/preview", { account_id: "acct-1", csv: CSV }, null),
      {} as never, () => {},
    );
    expect(res).toMatchObject({ status: "failed" });
  });
});

describe("POST /plan-statement/import", () => {
  test("inserts the new rows without overwriting any, and saves the mapping, in one transaction", async () => {
    const res = await postPlanStatementImportRoute.callback(
      makeReq("/plan-statement/import", { account_id: "acct-1", csv: CSV, mappings: MAPPINGS }),
      {} as never, () => {},
    );
    expect(res).toMatchObject({ status: "success", body: { written: 2, alreadyImported: 0 } });

    const clientSql = mockClientQuery.mock.calls.map(([sql]) => String(sql));
    expect(clientSql[0]).toBe("BEGIN");
    expect(clientSql.at(-1)).toBe("COMMIT");
    const insert = clientSql.find((sql) => sql.includes("INSERT INTO investment_transactions"))!;
    expect(insert).toContain("ON CONFLICT (investment_transaction_id) DO NOTHING");
    const mapping = clientSql.find((sql) => sql.includes("INSERT INTO plan_fund_mappings"))!;
    expect(updateColumnsOf(mapping).sort()).toEqual(["is_deleted", "restated", "security_id", "updated"]);
  });

  test("an import with a blocker writes nothing", async () => {
    const res = await postPlanStatementImportRoute.callback(
      makeReq("/plan-statement/import", { account_id: "acct-1", csv: CSV }),
      {} as never, () => {},
    );
    expect(res).toMatchObject({ status: "failed" });
    expect((res as { message: string }).message).toContain("Map EXAMPLE INDEX FUND to a security");
    expect(writes()).toEqual([]);
  });
});
