import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakePg, restoreEnv, restoreLeaves } from "test-helpers";

type Row = Record<string, unknown>;

const db = {
  provider: "manual" as string,
  accountType: "investment" as string,
  /** Ids already in the account; every one is soft-deleted. */
  existingIds: [] as string[],
  /** Fund mappings already saved on the account. */
  savedMappings: null as Row | null,
  /** Entered holding snapshots on the security. */
  snapshotIds: [] as string[],
  /** Make the holdings write fail, as a deadlock victim would. */
  failHoldings: false,
  /** Ids the account-wide deleted-row read returns. */
  deletedIds: [] as string[],
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
  plan_fund_mappings: null,
  raw: null,
  updated: null,
  is_deleted: false,
};

const respond = async (sql: string, values: unknown[] = []): Promise<Row[]> => {
  if (/FROM accounts\b/i.test(sql)) return [{ ...ACCOUNT, type: db.accountType, plan_fund_mappings: db.savedMappings }];
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
    return values
      .flat()
      .filter((id) => id === "sec-index" || id === "sec-bond")
      .map((security_id) => ({
        security_id,
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
      }));
  }
  if (/^\s*INSERT INTO holdings/i.test(sql) && db.failHoldings) {
    throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
  }
  if (/FROM snapshots\b/i.test(sql)) {
    return db.snapshotIds.map((snapshot_id) => ({
      snapshot_id,
      user_id: "usr-1",
      snapshot_date: "2026-01-02T12:00:00.000Z",
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
      institution_value: 250,
      cost_basis: null,
      quantity: 10,
      updated: null,
      is_deleted: false,
    }));
  }
  if (/FROM investment_transactions\b.*is_deleted = \$3/is.test(sql)) return db.deletedIds.map(deletedRow);
  if (/FROM investment_transactions\b.*investment_transaction_id IN/is.test(sql)) {
    // Every existing row here is soft-deleted, so a read that filters deleted rows finds none.
    if (/is_deleted/.test(sql)) return [];
    return db.existingIds.map(deletedRow);
  }
  return [];
};

const deletedRow = (id: string): Row => ({
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
});

const { pg, mockQuery, mockClientQuery, clearQueryMocks } = createFakePg(async (sql: string, values?: unknown[]) => {
  const rows = await respond(sql, values);
  return { rows: rows as unknown[], rowCount: rows.length };
});

mock.module("pg", () => pg);

const { postPlanStatementImportRoute } = await import("./post-plan-statement");
const { getDailyClosesRoute } = await import("./get-daily-closes");
const { getPlanStatementDeletedIdsRoute } = await import("./get-plan-statement-deleted-ids");
const { polygonLookupRateLimiter, clearDailyClosesCache, peekDailyCloses } = await import("server");

afterAll(restoreLeaves);

const ROW_ID = `plan-${"a".repeat(32)}`;

const shareLeg = (id = ROW_ID, extra: Row = {}) => ({
  transaction: {
    investment_transaction_id: id,
    account_id: "acct-1",
    security_id: "sec-index",
    date: "2026-03-02",
    name: "Buy (contribution)",
    amount: 1000,
    quantity: 20,
    price: 50,
    iso_currency_code: "USD",
    type: "buy",
    subtype: "contribution",
    source: "manual",
    ...extra,
  },
});

const cashLeg = (id = `${ROW_ID}-cash`) => ({
  transaction: {
    investment_transaction_id: id,
    account_id: "acct-1",
    security_id: null,
    date: "2026-03-02",
    name: "Contribution",
    amount: -1000,
    quantity: 0,
    price: 0,
    iso_currency_code: "USD",
    type: "cash",
    subtype: "contribution",
    source: "manual",
  },
});

const MAPPINGS = [{ investment: "EXAMPLE INDEX FUND", security_id: "sec-index", restated: false }];
const HOLDINGS = [{ security_id: "sec-index", date: "2026-03-02", quantity: 2, cost_basis: 100, price: 50 }];

const importBody = (extra: Record<string, unknown> = {}) => ({
  account_id: "acct-1",
  transactions: [shareLeg(), cashLeg()],
  mappings: MAPPINGS,
  holdings: HOLDINGS,
  ...extra,
});

const makeReq = (method: string, path: string, body: unknown, query: Row = {}, userId: string | null = "usr-1") =>
  ({
    method,
    path,
    url: `http://x/api${path}`,
    body,
    query,
    headers: {},
    session: userId ? { user: { user_id: userId, username: "tester" } } : {},
  }) as never;

const importStatement = (body: unknown, userId: string | null = "usr-1") =>
  postPlanStatementImportRoute.callback(makeReq("POST", "/plan-statement/import", body, {}, userId), {} as never, () => {});

const clientCalls = () =>
  mockClientQuery.mock.calls.map(([sql, values]) => ({ sql: String(sql), values: (values ?? []) as unknown[] }));

const writes = () =>
  [...mockQuery.mock.calls, ...mockClientQuery.mock.calls]
    .map(([sql]) => String(sql))
    .filter((sql) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql));

beforeEach(() => {
  clearQueryMocks();
  db.provider = "manual";
  db.accountType = "investment";
  db.existingIds = [];
  db.savedMappings = null;
  db.snapshotIds = [];
  db.failHoldings = false;
  db.deletedIds = [];
});

describe("POST /plan-statement/import", () => {
  test("stores the planned rows, the mappings and the holdings row in one transaction", async () => {
    const res = await importStatement(importBody());
    expect(res).toMatchObject({ status: "success", body: { written: 2, alreadyImported: 0 } });

    const calls = clientCalls();
    const sql = calls.map((c) => c.sql);
    expect(sql[0]).toBe("BEGIN");
    expect(sql[sql.length - 1]).toBe("COMMIT");
    const insert = calls.find((c) => c.sql.includes("INSERT INTO investment_transactions"))!;
    expect(insert.values).toContain(ROW_ID);
    expect(insert.values).toContain(`${ROW_ID}-cash`);
    // The rows are new, so the insert updates nothing on a conflict.
    expect(insert.sql).toMatch(/ON CONFLICT \(investment_transaction_id\) DO NOTHING/);
    const mapping = calls.find((c) => /^UPDATE accounts SET/.test(c.sql))!;
    expect(JSON.stringify(mapping.values)).toContain('"EXAMPLE INDEX FUND":{"security_id":"sec-index","restated":false}');
    const holding = calls.find((c) => c.sql.includes("INSERT INTO holdings"))!;
    expect(holding.values).toEqual(expect.arrayContaining(["acct-1-sec-index", 2, 100, 50]));
  });

  test("a row already in the account, deleted ones included, is left as it is", async () => {
    db.existingIds = [ROW_ID, `${ROW_ID}-cash`];
    const res = await importStatement(importBody());
    expect(res).toMatchObject({ status: "success", body: { written: 0, alreadyImported: 2 } });
    expect(writes().some((sql) => sql.includes("INSERT INTO investment_transactions"))).toBe(false);
  });

  test("stores only the checked fields of a row, as a manual row", async () => {
    const leg = shareLeg(ROW_ID, { source: "plaid", label_memo: "x-memo", label: { budget_id: "x-budget" }, raw: { x: 1 } });
    await importStatement(importBody({ transactions: [{ ...leg, restated_from: { investment: "T", units: 2, unit_price: 50, x: 9 } }] }));
    const insert = clientCalls().find((c) => c.sql.includes("INSERT INTO investment_transactions"))!;
    const stored = JSON.stringify(insert.values);
    expect(insert.values).toContain("manual");
    expect(insert.values).not.toContain("plaid");
    expect(stored).not.toContain("x-memo");
    expect(stored).not.toContain("x-budget");
    expect(stored).toContain('{"restated_from":{"investment":"T","units":2,"unit_price":50}}');
  });

  test("stores what a reinvestment was inferred from on its share leg", async () => {
    const leg = shareLeg(ROW_ID, { subtype: "dividend reinvestment", name: "Buy (dividend reinvestment)" });
    const reinvested_distribution = { ex_date: "2026-03-02", cash_amount_per_share: 0.5, shares_held: 40, x: 9 };
    const res = await importStatement(importBody({ transactions: [{ ...leg, reinvested_distribution }] }));
    expect(res).toMatchObject({ status: "success" });
    const insert = clientCalls().find((c) => c.sql.includes("INSERT INTO investment_transactions"))!;
    expect(JSON.stringify(insert.values)).toContain(
      '{"reinvested_distribution":{"ex_date":"2026-03-02","cash_amount_per_share":0.5,"shares_held":40}}',
    );
  });

  test("refuses a reinvestment record on a cash leg, or dated off its row", async () => {
    const record = { ex_date: "2026-03-02", cash_amount_per_share: 0.5, shares_held: 40 };
    for (const transactions of [
      [{ ...cashLeg(), reinvested_distribution: record }],
      [{ ...shareLeg(), reinvested_distribution: { ...record, ex_date: "2026-03-03" } }],
      [{ ...shareLeg(), reinvested_distribution: { ...record, shares_held: "40" } }],
      [{ ...shareLeg(), reinvested_distribution: "2026-03-02" }],
    ]) {
      clearQueryMocks();
      const res = await importStatement(importBody({ transactions }));
      expect(res).toMatchObject({ status: "failed", message: expect.stringContaining("unreadable reinvestment") });
      expect(writes()).toEqual([]);
    }
  });

  test("keeps the account's other saved mappings", async () => {
    db.savedMappings = { "EXAMPLE BOND FUND": { security_id: "sec-bond", restated: true } };
    await importStatement(importBody());
    const mapping = clientCalls().find((c) => /^UPDATE accounts SET/.test(c.sql))!;
    const saved = JSON.stringify(mapping.values);
    expect(saved).toContain('"EXAMPLE BOND FUND":{"security_id":"sec-bond","restated":true}');
    expect(saved).toContain('"EXAMPLE INDEX FUND":{"security_id":"sec-index","restated":false}');
  });

  test("replacing retires the security's entered positions", async () => {
    db.snapshotIds = ["holding-acct-1-sec-index-20260102"];
    await importStatement(importBody({ replace: ["sec-index"] }));
    const retire = clientCalls().find((c) => /^UPDATE snapshots SET is_deleted = TRUE/.test(c.sql));
    expect(retire?.values).toEqual(expect.arrayContaining(["holding-acct-1-sec-index-20260102", "usr-1"]));
  });

  test("without replace, entered positions are left alone", async () => {
    db.snapshotIds = ["holding-acct-1-sec-index-20260102"];
    await importStatement(importBody());
    expect(writes().some((sql) => /UPDATE snapshots SET is_deleted/.test(sql))).toBe(false);
  });

  test("refuses an account that isn't a manual investment account", async () => {
    db.provider = "plaid";
    expect(await importStatement(importBody())).toMatchObject({ status: "failed" });
    db.provider = "manual";
    db.accountType = "depository";
    expect(await importStatement(importBody())).toMatchObject({ status: "failed" });
    expect(writes()).toEqual([]);
  });

  test.each([
    ["an id that isn't a plan statement row's", [shareLeg("manual-123")]],
    ["a row for another account", [shareLeg(ROW_ID, { account_id: "acct-2" })]],
    ["a share row typed as cash", [shareLeg(ROW_ID, { type: "cash" })]],
    ["a cash leg with a security", [{ transaction: { ...cashLeg().transaction, security_id: "sec-index" } }]],
    ["a figure that isn't a number", [shareLeg(ROW_ID, { quantity: "20" })]],
    ["a subtype no statement kind writes", [shareLeg(ROW_ID, { subtype: "stock split" })]],
    ["a calendar-invalid date", [shareLeg(ROW_ID, { date: "2026-02-30" })]],
    ["a month past December", [shareLeg(ROW_ID, { date: "2026-13-01" })]],
    ["a cash leg with a share subtype", [{ transaction: { ...cashLeg().transaction, subtype: "dividend reinvestment" } }]],
    ["a currency past the column's length", [shareLeg(ROW_ID, { iso_currency_code: "DOLLARS-USD" })]],
  ])("refuses %s and writes nothing", async (_, transactions) => {
    expect(await importStatement(importBody({ transactions }))).toMatchObject({ status: "failed" });
    expect(writes()).toEqual([]);
  });

  test.each(["2026-02-30", "2026-13-01", "2026-00-10", "2026-03-32"])(
    "refuses a holding dated %s as a request error and writes nothing",
    async (date) => {
      const res = await importStatement(importBody({ holdings: [{ ...HOLDINGS[0], date }] }));
      expect(res).toMatchObject({ status: "failed", message: "each holding needs a YYYY-MM-DD date" });
      expect(writes()).toEqual([]);
    },
  );

  test("refuses a security that doesn't exist", async () => {
    const res = await importStatement(importBody({ transactions: [shareLeg(ROW_ID, { security_id: "sec-gone" })] }));
    expect(res).toMatchObject({ status: "failed", message: "Security sec-gone not found." });
    expect(writes()).toEqual([]);
  });

  test.each([
    { account_id: "acct-1" },
    { account_id: "acct-1", transactions: "x", mappings: [], holdings: [] },
    { account_id: "acct-1", transactions: [], mappings: [{ investment: "", security_id: "s", restated: false }], holdings: [] },
    { account_id: "acct-1", transactions: [], mappings: [], holdings: [{ security_id: "s", date: "2026-03-02", quantity: 1 }] },
    { account_id: "acct-1", transactions: [], mappings: [], holdings: [], replace: [1] },

  ])("rejects a malformed body %#", async (body) => {
    expect(await importStatement(body)).toMatchObject({ status: "failed" });
    expect(writes()).toEqual([]);
  });

  test("a failing holdings write fails the import instead of committing", async () => {
    db.failHoldings = true;
    await expect(importStatement(importBody())).rejects.toThrow("deadlock detected");
    const sql = clientCalls().map((c) => c.sql);
    expect(sql).toContain("ROLLBACK");
    expect(sql).not.toContain("COMMIT");
  });

  test("a long statement is inserted in chunks Postgres can bind", async () => {
    const transactions = Array.from({ length: 2200 }, (_, i) => shareLeg(`plan-${i.toString(16).padStart(32, "0")}`));
    const res = await importStatement(importBody({ transactions }));
    expect(res).toMatchObject({ status: "success", body: { written: 2200 } });
    const inserts = mockClientQuery.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO investment_transactions"));
    expect(inserts).toHaveLength(3);
    for (const [, values] of inserts) expect((values as unknown[]).length).toBeLessThan(65_535);
  });

  test("requires a signed-in user", async () => {
    expect(await importStatement(importBody(), null)).toMatchObject({ status: "failed" });
  });
});

describe("GET /plan-statement/deleted-ids", () => {
  const getDeleted = (query: Row, userId: string | null = "usr-1") =>
    getPlanStatementDeletedIdsRoute.callback(
      makeReq("GET", "/plan-statement/deleted-ids", undefined, query, userId),
      {} as never,
      () => {},
    );

  test("returns the account's deleted plan-statement rows, read for this user and account", async () => {
    db.deletedIds = [ROW_ID, `${ROW_ID}-cash`, "manual-abc"];
    const res = await getDeleted({ account_id: "acct-1" });
    expect(res).toEqual({ status: "success", body: { ids: [ROW_ID, `${ROW_ID}-cash`] } });
    const read = mockQuery.mock.calls
      .map(([sql, values]) => ({ sql: String(sql), values }))
      .find((c) => c.sql.includes("FROM investment_transactions"))!;
    expect(read.sql).toMatch(/user_id = \$1 AND account_id = \$2 AND is_deleted = \$3/);
    expect(read.values).toEqual(["usr-1", "acct-1", true]);
  });

  test("needs an account and a signed-in user", async () => {
    expect(await getDeleted({})).toMatchObject({ status: "failed" });
    expect(await getDeleted({ account_id: "acct-1" }, null)).toMatchObject({ status: "failed" });
  });
});

describe("GET /daily-closes", () => {
  const getCloses = (query: Row) =>
    getDailyClosesRoute.callback(makeReq("GET", "/daily-closes", undefined, query), {} as never, () => {});
  const RANGE = { ticker: "XIDX", from: "2026-02-20", to: "2026-03-02" };

  test("rejects a bad ticker or range", async () => {
    for (const query of [
      { ...RANGE, ticker: "bad ticker!" },
      { ...RANGE, from: "2026-02-30" },
      { ...RANGE, from: "2026-13-01" },
      { ...RANGE, to: "2026-00-10" },
      { ...RANGE, from: "2026-03-05" },
      { ticker: "XIDX", from: "2026-02-20" },
    ]) {
      expect(await getCloses(query)).toMatchObject({ status: "failed" });
    }
  });

  test("a lookup is charged to the user's lookup budget once", async () => {
    process.env.POLYGON_API_KEY = "";
    clearDailyClosesCache();
    polygonLookupRateLimiter.reset("usr-1");
    try {
      const first = await getCloses(RANGE);
      expect(JSON.stringify(first)).toContain("Polygon API key not configured");
      expect(polygonLookupRateLimiter.remaining("usr-1")).toBe(9);
      // The failure is remembered, so asking again reaches no gate and costs nothing.
      await getCloses(RANGE);
      expect(polygonLookupRateLimiter.remaining("usr-1")).toBe(9);

      clearDailyClosesCache();
      polygonLookupRateLimiter.consume("usr-1", 9);
      const shed = await getCloses(RANGE);
      expect(JSON.stringify(shed)).toContain("Too many ticker lookups");
    } finally {
      restoreEnv();
      polygonLookupRateLimiter.reset("usr-1");
      clearDailyClosesCache();
    }
  });

  test("closes still queued come back retryable and keep loading in the background", async () => {
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
    try {
      const res = await getCloses(RANGE);
      expect(res).toMatchObject({
        status: "success",
        body: { retryable: true, message: "Prices for XIDX are still loading. Retry in a minute." },
      });
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
    const res = await getDailyClosesRoute.callback(
      makeReq("GET", "/daily-closes", undefined, RANGE, null),
      {} as never,
      () => {},
    );
    expect(res).toMatchObject({ status: "failed" });
  });
});
