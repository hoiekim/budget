import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakePg, restoreEnv, restoreLeaves, updateColumnsOf } from "test-helpers";

type Row = Record<string, unknown>;

const db = {
  provider: "manual" as string,
  accountType: "investment" as string,
  existingIds: [] as string[],
  /** Live rows on the holding, as the refresh reads them inside the transaction. */
  live: [] as Row[],
  /** Holding snapshots already stored on the holding. */
  snapshots: [] as { id: string; date: string; quantity: number }[],
  /** The holding's current holdings row, if any. */
  holdings: [] as Row[],
  /** Make the holdings write fail, as a deadlock victim would. */
  failHoldings: false,
};

const enteredSnapshot = (date: string, quantity: number) => ({
  id: `holding-acct-1-sec-index-${date.replaceAll("-", "")}`,
  date,
  quantity,
});

const liveRow = (id: string, date: string, quantity: number, amount: number): Row => ({
  investment_transaction_id: id,
  user_id: "usr-1",
  account_id: "acct-1",
  security_id: "sec-index",
  date,
  name: null,
  amount,
  quantity,
  price: amount / quantity,
  iso_currency_code: "USD",
  type: "buy",
  subtype: "buy",
  label_budget_id: null,
  label_category_id: null,
  label_memo: null,
  raw: null,
  updated: null,
  is_deleted: false,
  source: "manual",
});

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
  if (/^\s*INSERT INTO holdings/i.test(sql) && db.failHoldings) {
    throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
  }
  if (/FROM holdings\b/i.test(sql)) return db.holdings;
  if (/FROM snapshots\b/i.test(sql)) {
    return db.snapshots.map(({ id, date, quantity }) => ({
      snapshot_id: id,
      user_id: "usr-1",
      snapshot_date: `${date}T12:00:00.000Z`,
      snapshot_type: "holding",
      account_id: null,
      balances_available: null,
      balances_current: null,
      balances_limit: null,
      balances_iso_currency_code: null,
      security_id: null,
      close_price: null,
      holding_account_id: "acct-1",
      holding_security_id: "sec-index",
      institution_price: 25,
      institution_value: quantity * 25,
      cost_basis: quantity * 25,
      quantity,
      updated: null,
      is_deleted: false,
    }));
  }
  if (/FROM investment_transactions\b.*\bsecurity_id IN/is.test(sql)) return db.live;
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
const { getRowIds, parsePlanStatement, polygonLookupRateLimiter, clearDailyClosesCache, peekDailyCloses } =
  await import("server");

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
  db.live = [];
  db.snapshots = [];
  db.holdings = [];
  db.failHoldings = false;
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

  test("a restated fund's price lookup is charged to the user's lookup budget once", async () => {
    process.env.POLYGON_API_KEY = "";
    clearDailyClosesCache();
    polygonLookupRateLimiter.reset("usr-1");
    const body = {
      account_id: "acct-1",
      csv: CSV,
      mappings: [{ investment: "EXAMPLE INDEX FUND", security_id: "sec-index", restated: true }],
    };
    try {
      const first = await postPlanStatementPreviewRoute.callback(makeReq("/plan-statement/preview", body), {} as never, () => {});
      expect(JSON.stringify(first)).toContain("Polygon API key not configured");
      expect(polygonLookupRateLimiter.remaining("usr-1")).toBe(9);
      // The failure is remembered, so asking again reaches no gate and costs nothing.
      await postPlanStatementPreviewRoute.callback(makeReq("/plan-statement/preview", body), {} as never, () => {});
      expect(polygonLookupRateLimiter.remaining("usr-1")).toBe(9);

      clearDailyClosesCache();
      polygonLookupRateLimiter.consume("usr-1", 9);
      const shed = await postPlanStatementPreviewRoute.callback(makeReq("/plan-statement/preview", body), {} as never, () => {});
      expect(JSON.stringify(shed)).toContain("Too many ticker lookups");
    } finally {
      restoreEnv();
      polygonLookupRateLimiter.reset("usr-1");
      clearDailyClosesCache();
    }
  });

  test("a restated fund whose prices are still queued comes back retryable and keeps loading in the background", async () => {
    process.env.POLYGON_API_KEY = "test-key";
    process.env.POLYGON_RATE_LIMIT_PER_MIN = "0";
    process.env.YAHOO_RATE_LIMIT_PER_MIN = "0";
    clearDailyClosesCache();
    polygonLookupRateLimiter.reset("usr-1");
    const realFetch = globalThis.fetch;
    // Polygon has no bars for the symbol and Yahoo's gate is busy.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const fetchMock = mock(async (url: string) => {
      // Hold anything after the request's own two calls, so a background fetch stays visible.
      if (++calls > 2) await held;
      return url.includes("polygon.io")
        ? ({ ok: true, status: 200, json: async () => ({ status: "OK" }) } as Response)
        : ({ ok: false, status: 429, json: async () => ({}) } as Response);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const body = {
      account_id: "acct-1",
      csv: CSV,
      mappings: [{ investment: "EXAMPLE INDEX FUND", security_id: "sec-index", restated: true }],
    };
    try {
      const res = await postPlanStatementPreviewRoute.callback(makeReq("/plan-statement/preview", body), {} as never, () => {});
      const fund = (res as { body: { funds: { restatement?: { retryable?: boolean; message?: string } }[] } }).body.funds[0];
      expect(fund.restatement).toMatchObject({ retryable: true, message: "Prices for XIDX are still loading. Retry in a minute." });
      expect(peekDailyCloses("XIDX", "2026-02-20", "2026-03-02")).toBe("loading");
      release();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      globalThis.fetch = realFetch;
      restoreEnv();
      polygonLookupRateLimiter.reset("usr-1");
      clearDailyClosesCache();
    }
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

  const importBody = (extra: Record<string, unknown> = {}) => ({ account_id: "acct-1", csv: CSV, mappings: MAPPINGS, ...extra });
  const clientCalls = () =>
    mockClientQuery.mock.calls.map(([sql, values]) => ({ sql: String(sql), values: (values ?? []) as unknown[] }));

  test("rewrites the holding from every live row, read and written inside the same transaction", async () => {
    db.live = [liveRow("hand-entered", "2026-02-10", 4, 200), liveRow("plan-x", "2026-03-02", 20, 1000)];
    const res = await postPlanStatementImportRoute.callback(makeReq("/plan-statement/import", importBody()), {} as never, () => {});
    expect(res).toMatchObject({ status: "success" });

    const calls = clientCalls();
    const commit = calls.findIndex((c) => c.sql === "COMMIT");
    // The holding's rows and snapshots are read on the transaction, not the pool.
    for (const read of [/FROM investment_transactions\b.*\bsecurity_id IN/is, /FROM snapshots\b/i, /FROM holdings\b/i]) {
      const at = calls.findIndex((c) => read.test(c.sql));
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(commit);
    }
    const snapshotInserts = calls.filter((c) => c.sql.includes("INSERT INTO snapshots"));
    expect(snapshotInserts).toHaveLength(1);
    const values = snapshotInserts[0].values;
    expect(values).toContain("plan-holding-acct-1-sec-index-20260210");
    expect(values).toContain("2026-02-10T12:00:00Z");
    expect(values).toContain("2026-03-02T12:00:00Z");
    // The hand-entered February buy counts toward March's position.
    expect(values).toContain(24);

    // Snapshots first, then the holdings row: the order account deletion takes them in.
    const holding = calls.findIndex((c) => c.sql.includes("INSERT INTO holdings"));
    expect(holding).toBeGreaterThan(calls.indexOf(snapshotInserts[0]));
    expect(holding).toBeLessThan(commit);
    expect(calls[holding].values).toContain(24);
    expect(mockQuery.mock.calls.some(([sql]) => /INSERT INTO (snapshots|holdings)/.test(String(sql)))).toBe(false);
  });

  test("an entered position the transactions don't explain is disclosed and kept by default", async () => {
    db.live = [liveRow("plan-x", "2026-03-02", 20, 1000)];
    db.snapshots = [enteredSnapshot("2026-01-15", 100)];

    const preview = await postPlanStatementPreviewRoute.callback(makeReq("/plan-statement/preview", importBody()), {} as never, () => {});
    const fund = (preview as { body: { funds: { positionGaps?: unknown; replacePositions?: boolean }[] } }).body.funds[0];
    expect(fund.positionGaps).toEqual([{ date: "2026-01-15", stored: 100, explained: 0 }]);
    expect(fund.replacePositions).toBe(false);

    clearQueryMocks();
    await postPlanStatementImportRoute.callback(makeReq("/plan-statement/import", importBody()), {} as never, () => {});
    const calls = clientCalls();
    const snapshotValues = calls.find((c) => c.sql.includes("INSERT INTO snapshots"))!.values;
    expect(snapshotValues).not.toContain("holding-acct-1-sec-index-20260115");
    expect(snapshotValues).toContain(120);
    expect(calls.find((c) => c.sql.includes("INSERT INTO holdings"))!.values).toContain(120);
  });

  test("replacing writes the transactions' figures over the entered position", async () => {
    db.live = [liveRow("plan-x", "2026-03-02", 20, 1000)];
    db.snapshots = [enteredSnapshot("2026-01-15", 100)];
    await postPlanStatementImportRoute.callback(
      makeReq("/plan-statement/import", importBody({ replacePositions: ["EXAMPLE INDEX FUND"] })),
      {} as never, () => {},
    );
    const calls = clientCalls();
    const snapshotValues = calls.find((c) => c.sql.includes("INSERT INTO snapshots"))!.values;
    const entered = snapshotValues.indexOf("holding-acct-1-sec-index-20260115");
    expect(entered).toBeGreaterThanOrEqual(0);
    expect(snapshotValues).not.toContain(120);
    expect(calls.find((c) => c.sql.includes("INSERT INTO holdings"))!.values).toContain(20);
  });

  test("writes nothing for a holding whose snapshots and row are already right", async () => {
    db.live = [liveRow("plan-x", "2026-03-02", 20, 500)];
    const thisMonth = new Date().toISOString().slice(0, 7);
    const months: string[] = [];
    for (let m = "2026-04"; m <= thisMonth; ) {
      months.push(m);
      const [y, mo] = m.split("-").map(Number);
      m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
    }
    db.snapshots = ["2026-03-02", ...months.map((m) => `${m}-01`)].map((date) => ({
      id: `plan-holding-acct-1-sec-index-${date.replaceAll("-", "")}`,
      date,
      quantity: 20,
    }));
    db.holdings = [
      {
        holding_id: "acct-1-sec-index",
        user_id: "usr-1",
        account_id: "acct-1",
        security_id: "sec-index",
        institution_price: 25,
        institution_price_as_of: `${thisMonth}-01`,
        institution_value: 500,
        cost_basis: 500,
        quantity: 20,
        iso_currency_code: null,
        raw: null,
        updated: null,
        is_deleted: false,
      },
    ];
    await postPlanStatementImportRoute.callback(makeReq("/plan-statement/import", importBody()), {} as never, () => {});
    expect(writes().some((sql) => /INSERT INTO (snapshots|holdings)/.test(sql))).toBe(false);
  });

  test("a failing holdings write fails the import instead of committing", async () => {
    db.live = [liveRow("plan-x", "2026-03-02", 20, 1000)];
    db.failHoldings = true;
    await expect(
      postPlanStatementImportRoute.callback(makeReq("/plan-statement/import", importBody()), {} as never, () => {}),
    ).rejects.toThrow("deadlock detected");
    const sql = clientCalls().map((c) => c.sql);
    expect(sql).toContain("ROLLBACK");
    expect(sql).not.toContain("COMMIT");
  });

  test("a long statement is inserted in chunks Postgres can bind", async () => {
    const lines = ["Date,Investment,Transaction Type,Amount,Shares/Unit"];
    for (let i = 0; i < 1100; i++) lines.push(`03/02/2026,EXAMPLE INDEX FUND,Contributions,${100 + i},2`);
    const res = await postPlanStatementImportRoute.callback(
      makeReq("/plan-statement/import", { account_id: "acct-1", csv: lines.join("\n"), mappings: MAPPINGS }),
      {} as never, () => {},
    );
    expect(res).toMatchObject({ status: "success", body: { written: 2200 } });
    const inserts = mockClientQuery.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO investment_transactions"));
    expect(inserts).toHaveLength(3);
    for (const [, values] of inserts) expect((values as unknown[]).length).toBeLessThan(65_535);
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
