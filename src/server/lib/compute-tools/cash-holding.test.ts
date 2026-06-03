//
// `inferCashHoldings` and `ensureUSDCashSecurity` lost their DI seams in
// this PR — both call into `searchSecurities` / `upsertSecurities` /
// `pool.query` directly. Tests leaf-mock `pg`: every securities-table
// SELECT or UPSERT issued by the route surfaces as a `mockQuery.mock.calls`
// entry. Tests that exercise the cash-security lookup pre-queue the
// SELECT response (and INSERT response when needed) on `mockQuery`.
import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";
import { AccountType } from "plaid";

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

const { inferCashHoldings, ensureUSDCashSecurity } = await import("./cash\-holding");

afterAll(restoreLeaves);

const makeAccount = (overrides: Record<string, unknown> = {}) => ({
  account_id: "acc-1",
  type: AccountType.Investment,
  name: "Test Investment",
  institution_id: "ins-1",
  item_id: "item-1",
  balances: { current: 1000, available: null, limit: null, iso_currency_code: "USD" },
  hide: false,
  custom_name: "",
  label: {},
  graphOptions: {},
  ...overrides,
});

const makeHolding = (overrides: Record<string, unknown> = {}) => ({
  holding_id: "h-1",
  account_id: "acc-1",
  security_id: "sec-aapl",
  quantity: 5,
  institution_price: 100,
  institution_price_as_of: "2026-05-01",
  institution_value: 500,
  cost_basis: 400,
  iso_currency_code: "USD",
  unofficial_currency_code: null,
  ...overrides,
});

const makeSecurity = (overrides: Record<string, unknown> = {}) => ({
  security_id: "sec-aapl",
  ticker_symbol: "AAPL",
  name: "Apple Inc.",
  type: "equity",
  close_price: 100,
  close_price_as_of: "2026-05-01",
  iso_currency_code: "USD",
  isin: null,
  cusip: null,
  sedol: null,
  institution_security_id: null,
  institution_id: null,
  proxy_security_id: null,
  is_cash_equivalent: false,
  update_datetime: null,
  unofficial_currency_code: null,
  market_identifier_code: null,
  sector: null,
  industry: null,
  option_contract: null,
  fixed_income: null,
  ...overrides,
});

/** Raw securities-table row matching SecurityModel's schema. */
const cashSecurityDbRow = (overrides: Record<string, unknown> = {}) => ({
  security_id: "sec-usd-cash",
  name: "US Dollar Cash",
  ticker_symbol: "USD",
  type: "cash",
  close_price: 1,
  close_price_as_of: null,
  iso_currency_code: "USD",
  isin: null,
  cusip: null,
  raw: null,
  updated: null,
  ...overrides,
});

/**
 * Pre-queue the SELECT response for the cash-security lookup. Returns
 * the canonical USD cash row when an account actually triggers
 * `ensureUSDCashSecurity()`. Used by tests that expect an inferred
 * cash holding to be synthesised.
 */
const queueCashSecurityLookup = () => {
  mockQuery.mockResolvedValueOnce({ rows: [cashSecurityDbRow()], rowCount: 1 });
};

const findInsertCall = (table: RegExp): { sql: string; values: unknown[] } | null => {
  for (const call of mockQuery.mock.calls) {
    const sql = call[0] as string;
    if (table.test(sql)) return { sql, values: call[1] as unknown[] };
  }
  return null;
};

beforeEach(() => {
  mockQuery.mockReset();
});

describe("inferCashHoldings", () => {
  test("synthesises a USD cash holding when balance > non-cash holdings sum", async () => {
    queueCashSecurityLookup();
    const account = makeAccount({ balances: { current: 1500, iso_currency_code: "USD" } });
    const holdings = [makeHolding({ institution_value: 1000 })];
    const securities = [makeSecurity()];

    const result = await inferCashHoldings([account], holdings, securities);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      account_id: "acc-1",
      security_id: "sec-usd-cash",
      quantity: 500,
      institution_value: 500,
      institution_price: 1,
    });
  });

  test("skips when a cash-type holding already exists for the account", async () => {
    const account = makeAccount({ balances: { current: 1500, iso_currency_code: "USD" } });
    const holdings = [
      makeHolding({ institution_value: 1000 }),
      makeHolding({ holding_id: "h-2", security_id: "sec-cash-1", institution_value: 200 }),
    ];
    const securities = [
      makeSecurity(),
      makeSecurity({ security_id: "sec-cash-1", ticker_symbol: "QACDS", type: "cash" }),
    ];

    const result = await inferCashHoldings([account], holdings, securities);

    expect(result).toHaveLength(0);
    // No cash security lookup was triggered (no SELECT/UPSERT against
    // securities) because `hasCash` short-circuited the per-account loop.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("skips when a holding's ticker matches Plaid's CUR:* pattern", async () => {
    const account = makeAccount({ balances: { current: 1500 } });
    const holdings = [
      makeHolding({ holding_id: "h-2", security_id: "sec-cur-usd", institution_value: 200 }),
    ];
    const securities = [
      makeSecurity({ security_id: "sec-cur-usd", ticker_symbol: "CUR:USD", type: null }),
    ];

    const result = await inferCashHoldings([account], holdings, securities);

    expect(result).toHaveLength(0);
  });

  test("skips when is_cash_equivalent is true on the security", async () => {
    const account = makeAccount({ balances: { current: 1500 } });
    const holdings = [
      makeHolding({ holding_id: "h-2", security_id: "sec-money", institution_value: 200 }),
    ];
    const securities = [
      makeSecurity({
        security_id: "sec-money",
        ticker_symbol: "VMFXX",
        type: null,
        is_cash_equivalent: true,
      }),
    ];

    const result = await inferCashHoldings([account], holdings, securities);

    expect(result).toHaveLength(0);
  });

  test("skips when a holding has institution_price=1 and falsy cost_basis (money-market / proprietary sweep)", async () => {
    const account = makeAccount({ balances: { current: 1500, iso_currency_code: "USD" } });
    const holdings = [
      makeHolding({ institution_value: 1000 }),
      makeHolding({
        holding_id: "h-2",
        security_id: "sec-vmfxx",
        quantity: 200,
        institution_price: 1,
        institution_value: 200,
        cost_basis: 0,
      }),
    ];
    const securities = [
      makeSecurity(),
      makeSecurity({
        security_id: "sec-vmfxx",
        ticker_symbol: "VMFXX",
        name: "Vanguard Federal Money Market Fund",
        type: "etf",
        is_cash_equivalent: null,
      }),
    ];

    const result = await inferCashHoldings([account], holdings, securities);

    expect(result).toHaveLength(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("skips when cost_basis is null (DB-NULL collapse) and institution_price=1", async () => {
    const account = makeAccount({ balances: { current: 1500 } });
    const holdings = [
      makeHolding({
        holding_id: "h-cash",
        security_id: "sec-sweep",
        quantity: 200,
        institution_price: 1,
        institution_value: 200,
        cost_basis: null as unknown as number,
      }),
    ];
    const securities = [
      makeSecurity({
        security_id: "sec-sweep",
        ticker_symbol: "QACDS",
        type: "etf",
        is_cash_equivalent: false,
      }),
    ];

    const result = await inferCashHoldings([account], holdings, securities);

    expect(result).toHaveLength(0);
  });

  test("skips non-investment accounts entirely", async () => {
    const account = makeAccount({ type: AccountType.Depository });
    const result = await inferCashHoldings([account], [], []);
    expect(result).toHaveLength(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("skips when the inferred amount is below the noise threshold", async () => {
    const account = makeAccount({ balances: { current: 1000 } });
    const holdings = [makeHolding({ institution_value: 999.995 })];
    const securities = [makeSecurity()];

    const result = await inferCashHoldings([account], holdings, securities);

    expect(result).toHaveLength(0);
  });

  test("skips when balance is fully reconciled by holdings", async () => {
    const account = makeAccount({ balances: { current: 1000 } });
    const holdings = [makeHolding({ institution_value: 1000 })];
    const securities = [makeSecurity()];

    const result = await inferCashHoldings([account], holdings, securities);

    expect(result).toHaveLength(0);
  });

  test("handles a mix of accounts — some get cash, some don't", async () => {
    queueCashSecurityLookup();
    const accountA = makeAccount({
      account_id: "acc-a",
      balances: { current: 2000, iso_currency_code: "USD" },
    });
    const accountB = makeAccount({
      account_id: "acc-b",
      balances: { current: 500, iso_currency_code: "USD" },
    });
    const accountC = makeAccount({
      account_id: "acc-c",
      balances: { current: 1000, iso_currency_code: "USD" },
    });

    const holdings = [
      makeHolding({ account_id: "acc-a", institution_value: 1500 }),
      makeHolding({
        account_id: "acc-b",
        holding_id: "h-cash",
        security_id: "sec-cash",
        institution_value: 500,
      }),
      makeHolding({ account_id: "acc-c", institution_value: 1000 }),
    ];
    const securities = [
      makeSecurity(),
      makeSecurity({ security_id: "sec-cash", ticker_symbol: "QACDS", type: "cash" }),
    ];

    const result = await inferCashHoldings([accountA, accountB, accountC], holdings, securities);

    expect(result).toHaveLength(1);
    expect(result[0].account_id).toBe("acc-a");
    expect(result[0].quantity).toBe(500);
  });

  test("returns no holdings (and skips ensureUSDCashSecurity) when input is empty", async () => {
    const result = await inferCashHoldings([], [], []);
    expect(result).toHaveLength(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("calls ensureUSDCashSecurity once even across multiple accounts that need cash", async () => {
    // The first account triggers the SELECT against `securities`. Subsequent
    // accounts reuse the captured `cashSecurity` reference, so only ONE
    // securities-table SELECT is issued.
    queueCashSecurityLookup();
    const accountA = makeAccount({ account_id: "acc-a", balances: { current: 1000 } });
    const accountB = makeAccount({ account_id: "acc-b", balances: { current: 2000 } });

    const result = await inferCashHoldings([accountA, accountB], [], []);

    expect(result).toHaveLength(2);
    // Exactly one SELECT against the securities table — `cashSecurity` is
    // resolved lazily on first use and reused thereafter.
    const securitiesSelects = mockQuery.mock.calls.filter((c) =>
      /SELECT.*FROM\s+securities/i.test(c[0] as string),
    );
    expect(securitiesSelects).toHaveLength(1);
  });
});

describe("ensureUSDCashSecurity", () => {
  test("returns the existing USD cash security when one is already in the table", async () => {
    // The SELECT for ticker_symbol='USD' returns the cached row → no INSERT.
    mockQuery.mockResolvedValueOnce({ rows: [cashSecurityDbRow()], rowCount: 1 });

    const result = await ensureUSDCashSecurity();

    expect(result.ticker_symbol).toBe("USD");
    expect(result.type).toBe("cash");
    expect(findInsertCall(/INSERT\s+INTO\s+securities/i)).toBeNull();
  });

  test("creates the USD cash security on first call when none exists", async () => {
    // First SELECT returns empty → triggers the UPSERT.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // UPSERT returns the newly-created row.
    mockQuery.mockResolvedValueOnce({ rows: [cashSecurityDbRow()], rowCount: 1 });

    const result = await ensureUSDCashSecurity();

    expect(result.ticker_symbol).toBe("USD");
    expect(result.type).toBe("cash");
    expect(result.is_cash_equivalent).toBe(true);

    // INSERT was issued with the canonical USD cash row's fields.
    const ins = findInsertCall(/INSERT\s+INTO\s+securities/i);
    expect(ins).not.toBeNull();
    expect(ins!.values).toContain("USD");
    expect(ins!.values).toContain("US Dollar Cash");
    expect(ins!.values).toContain("cash");
  });
});
