/**
 * Tests for inferCashHoldings — covers the "no Plaid cash → synthesise"
 * path and all the skip conditions (existing cash holding, non-investment
 * account, sub-threshold delta, full reconciliation).
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { AccountType } from "plaid";

const mockSearchSecurities = mock(async (_opts: unknown) => [] as unknown[]);
const mockUpsertSecurities = mock(async (_secs: unknown[]) => []);
mock.module("server", () => ({
  searchSecurities: mockSearchSecurities,
  upsertSecurities: mockUpsertSecurities,
}));

import { inferCashHoldings } from "./cash-holding";

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

beforeEach(() => {
  mockSearchSecurities.mockReset();
  mockUpsertSecurities.mockReset();
  // Default: USD cash security already exists, no need to create.
  mockSearchSecurities.mockImplementation(async () => [
    makeSecurity({
      security_id: "sec-usd-cash",
      ticker_symbol: "USD",
      type: "cash",
      name: "US Dollar Cash",
      is_cash_equivalent: true,
    }),
  ]);
  mockUpsertSecurities.mockImplementation(async () => []);
});

describe("inferCashHoldings", () => {
  test("synthesises a USD cash holding when balance > non-cash holdings sum", async () => {
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
        type: null, // type may not be set, but the CUR: prefix marks it cash
      }),
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

  test("skips non-investment accounts entirely", async () => {
    const account = makeAccount({ type: AccountType.Depository });
    const result = await inferCashHoldings([account], [], []);
    expect(result).toHaveLength(0);
    // Should also not have probed the securities table.
    expect(mockSearchSecurities).toHaveBeenCalledTimes(0);
  });

  test("skips when the inferred amount is below the noise threshold", async () => {
    // $1000 balance, $999.995 in holdings → ~$0.005 delta, below threshold.
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
    }); // fully reconciled

    const holdings = [
      makeHolding({ account_id: "acc-a", institution_value: 1500 }), // delta 500 → infer
      makeHolding({
        account_id: "acc-b",
        holding_id: "h-cash",
        security_id: "sec-cash",
        institution_value: 500,
      }), // has cash already → skip
      makeHolding({ account_id: "acc-c", institution_value: 1000 }), // reconciled → skip
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

  test("returns no holdings (and skips the security lookup) when input is empty", async () => {
    const result = await inferCashHoldings([], [], []);
    expect(result).toHaveLength(0);
    expect(mockSearchSecurities).toHaveBeenCalledTimes(0);
  });

  test("only performs the security lookup once even across multiple accounts that need cash", async () => {
    const accountA = makeAccount({ account_id: "acc-a", balances: { current: 1000 } });
    const accountB = makeAccount({ account_id: "acc-b", balances: { current: 2000 } });

    const result = await inferCashHoldings([accountA, accountB], [], []);

    expect(result).toHaveLength(2);
    // The cash security is resolved lazily on first use and reused thereafter.
    expect(mockSearchSecurities).toHaveBeenCalledTimes(1);
  });

  test("creates the USD cash security on first inference if it doesn't exist yet", async () => {
    mockSearchSecurities.mockImplementationOnce(async () => []); // none in DB
    const account = makeAccount({ balances: { current: 1000 } });
    const result = await inferCashHoldings([account], [], []);

    expect(mockUpsertSecurities).toHaveBeenCalledTimes(1);
    const created = mockUpsertSecurities.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      ticker_symbol: "USD",
      type: "cash",
      is_cash_equivalent: true,
    });
    expect(result).toHaveLength(1);
  });
});
