/**
 * Tests for inferCashHoldings + ensureUSDCashSecurity.
 *
 * NOTE on mocking: we deliberately avoid `mock.module("server", ...)` here.
 * That mock is process-wide in Bun and leaks into sibling test files (the
 * snapshot repo tests, cron tests, etc.) that import their own barrel
 * pieces. Both functions take dependency-injection seams as positional
 * args, so we pass plain mock fns and the cross-file isolation problem
 * disappears.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { AccountType } from "plaid";

import { inferCashHoldings, ensureUSDCashSecurity } from "./cash-holding";

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

const makeCashSecurity = () =>
  makeSecurity({
    security_id: "sec-usd-cash",
    ticker_symbol: "USD",
    type: "cash",
    name: "US Dollar Cash",
    is_cash_equivalent: true,
  });

// Default DI stub: ensureCashSecurity returns the canonical USD cash row.
// Each test overrides via mockImplementationOnce when it needs different
// behaviour or asserts call count.
const mockEnsureCash = mock(async () => makeCashSecurity());

beforeEach(() => {
  mockEnsureCash.mockReset();
  mockEnsureCash.mockImplementation(async () => makeCashSecurity());
});

describe("inferCashHoldings", () => {
  test("synthesises a USD cash holding when balance > non-cash holdings sum", async () => {
    const account = makeAccount({ balances: { current: 1500, iso_currency_code: "USD" } });
    const holdings = [makeHolding({ institution_value: 1000 })];
    const securities = [makeSecurity()];

    const result = await inferCashHoldings([account], holdings, securities, mockEnsureCash);

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

    const result = await inferCashHoldings([account], holdings, securities, mockEnsureCash);

    expect(result).toHaveLength(0);
    expect(mockEnsureCash).toHaveBeenCalledTimes(0);
  });

  test("skips when a holding's ticker matches Plaid's CUR:* pattern", async () => {
    const account = makeAccount({ balances: { current: 1500 } });
    const holdings = [
      makeHolding({ holding_id: "h-2", security_id: "sec-cur-usd", institution_value: 200 }),
    ];
    const securities = [
      makeSecurity({
        security_id: "sec-cur-usd",
        ticker_symbol: "CUR:USD",
        type: null,
      }),
    ];

    const result = await inferCashHoldings([account], holdings, securities, mockEnsureCash);

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

    const result = await inferCashHoldings([account], holdings, securities, mockEnsureCash);

    expect(result).toHaveLength(0);
  });

  test("skips non-investment accounts entirely", async () => {
    const account = makeAccount({ type: AccountType.Depository });
    const result = await inferCashHoldings([account], [], [], mockEnsureCash);
    expect(result).toHaveLength(0);
    expect(mockEnsureCash).toHaveBeenCalledTimes(0);
  });

  test("skips when the inferred amount is below the noise threshold", async () => {
    const account = makeAccount({ balances: { current: 1000 } });
    const holdings = [makeHolding({ institution_value: 999.995 })];
    const securities = [makeSecurity()];

    const result = await inferCashHoldings([account], holdings, securities, mockEnsureCash);

    expect(result).toHaveLength(0);
  });

  test("skips when balance is fully reconciled by holdings", async () => {
    const account = makeAccount({ balances: { current: 1000 } });
    const holdings = [makeHolding({ institution_value: 1000 })];
    const securities = [makeSecurity()];

    const result = await inferCashHoldings([account], holdings, securities, mockEnsureCash);

    expect(result).toHaveLength(0);
  });

  test("handles a mix of accounts — some get cash, some don't", async () => {
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

    const result = await inferCashHoldings(
      [accountA, accountB, accountC],
      holdings,
      securities,
      mockEnsureCash,
    );

    expect(result).toHaveLength(1);
    expect(result[0].account_id).toBe("acc-a");
    expect(result[0].quantity).toBe(500);
  });

  test("returns no holdings (and skips ensureCashSecurity) when input is empty", async () => {
    const result = await inferCashHoldings([], [], [], mockEnsureCash);
    expect(result).toHaveLength(0);
    expect(mockEnsureCash).toHaveBeenCalledTimes(0);
  });

  test("calls ensureCashSecurity once even across multiple accounts that need cash", async () => {
    const accountA = makeAccount({ account_id: "acc-a", balances: { current: 1000 } });
    const accountB = makeAccount({ account_id: "acc-b", balances: { current: 2000 } });

    const result = await inferCashHoldings([accountA, accountB], [], [], mockEnsureCash);

    expect(result).toHaveLength(2);
    // Cash security resolved lazily on first use and reused thereafter.
    expect(mockEnsureCash).toHaveBeenCalledTimes(1);
  });
});

describe("ensureUSDCashSecurity", () => {
  test("returns the existing USD cash security when one is already in the table", async () => {
    const existing = makeCashSecurity();
    const mockSearch = mock(async (_opts: unknown) => [existing]);
    const mockUpsert = mock(async (_secs: unknown[]) => []);

    const result = await ensureUSDCashSecurity(
      mockSearch as unknown as Parameters<typeof ensureUSDCashSecurity>[0],
      mockUpsert as unknown as Parameters<typeof ensureUSDCashSecurity>[1],
    );

    expect(result).toBe(existing);
    expect(mockUpsert).toHaveBeenCalledTimes(0);
  });

  test("creates the USD cash security on first call when none exists", async () => {
    const mockSearch = mock(async (_opts: unknown) => [] as unknown[]);
    const mockUpsert = mock(async (_secs: unknown[]) => []);

    const result = await ensureUSDCashSecurity(
      mockSearch as unknown as Parameters<typeof ensureUSDCashSecurity>[0],
      mockUpsert as unknown as Parameters<typeof ensureUSDCashSecurity>[1],
    );

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const created = mockUpsert.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      ticker_symbol: "USD",
      type: "cash",
      is_cash_equivalent: true,
    });
    expect(result.ticker_symbol).toBe("USD");
  });
});
