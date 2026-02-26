import { describe, test, expect } from "bun:test";
import {
  SimpleFinAccount,
  SimpleFinTransaction,
  SimpleFinHolding,
  translateAccount,
  translateTransaction,
  translateInvestmentTransaction,
  translateHolding,
} from "./translators";
import { AccountType, InvestmentTransactionType, InvestmentTransactionSubtype } from "plaid";
import type { JSONItem } from "common";

const createMockOrg = () => ({
  id: "org-123",
  domain: "bank.example.com",
  name: "Example Bank",
  "sfin-url": "https://sfin.bank.example.com",
  url: "https://bank.example.com",
});

const createMockItem = (): JSONItem => ({
  item_id: "item-456",
  institution_id: "inst-789",
  webhook: null,
  error: null,
  available_products: [],
  billed_products: [],
  consent_expiration_time: null,
  update_type: "background",
  products: [],
  consented_products: [],
  access_token: "access-token-123",
});

const createMockSimpleFinAccount = (overrides?: Partial<SimpleFinAccount>): SimpleFinAccount => ({
  id: "acc-001",
  org: createMockOrg(),
  name: "Checking Account",
  currency: "USD",
  balance: "1500.50",
  "available-balance": "1400.25",
  "balance-date": 1704067200, // 2024-01-01T00:00:00Z
  transactions: [],
  holdings: [],
  ...overrides,
});

const createMockSimpleFinTransaction = (
  overrides?: Partial<SimpleFinTransaction>,
): SimpleFinTransaction => ({
  id: "txn-001",
  posted: 1704153600, // 2024-01-02T00:00:00Z
  amount: "-50.00",
  description: "Coffee Shop",
  payee: "Local Coffee",
  memo: "Morning coffee",
  transacted_at: 1704150000, // 2024-01-01T23:00:00Z
  ...overrides,
});

const createMockSimpleFinHolding = (overrides?: Partial<SimpleFinHolding>): SimpleFinHolding => ({
  id: "hold-001",
  created: 1704067200, // 2024-01-01T00:00:00Z
  currency: "USD",
  cost_basis: "1000.00",
  description: "Apple Inc.",
  market_value: "1200.00",
  purchase_price: "100.00",
  shares: "10",
  symbol: "AAPL",
  ...overrides,
});

describe("translateAccount", () => {
  test("translates basic checking account correctly", () => {
    const sfAccount = createMockSimpleFinAccount();
    const item = createMockItem();

    const { institution, account } = translateAccount(sfAccount, item);

    expect(institution).toEqual({
      institution_id: "org-123",
      name: "Example Bank",
      url: "https://bank.example.com",
      products: [],
      country_codes: [],
      routing_numbers: [],
      oauth: false,
    });

    expect(account.account_id).toBe("acc-001");
    expect(account.name).toBe("Checking Account");
    expect(account.balances.current).toBe(1500.5);
    expect(account.balances.available).toBe(1400.25);
    expect(account.balances.iso_currency_code).toBe("USD");
    expect(account.type).toBe(AccountType.Other);
    expect(account.item_id).toBe("item-456");
    expect(account.institution_id).toBe("org-123");
  });

  test("identifies investment account by holdings presence", () => {
    const sfAccount = createMockSimpleFinAccount({
      holdings: [createMockSimpleFinHolding()],
    });
    const item = createMockItem();

    const { account } = translateAccount(sfAccount, item);

    expect(account.type).toBe(AccountType.Investment);
  });

  test("identifies investment account by name containing 'investment'", () => {
    const sfAccount = createMockSimpleFinAccount({
      name: "My Investment Portfolio",
    });
    const item = createMockItem();

    const { account } = translateAccount(sfAccount, item);

    expect(account.type).toBe(AccountType.Investment);
  });

  test("identifies investment account by org name containing 'investment'", () => {
    const sfAccount = createMockSimpleFinAccount({
      org: {
        ...createMockOrg(),
        name: "Global Investment Services",
      },
    });
    const item = createMockItem();

    const { account } = translateAccount(sfAccount, item);

    expect(account.type).toBe(AccountType.Investment);
  });

  test("preserves account defaults", () => {
    const sfAccount = createMockSimpleFinAccount();
    const item = createMockItem();

    const { account } = translateAccount(sfAccount, item);

    expect(account.mask).toBeNull();
    expect(account.official_name).toBeNull();
    expect(account.subtype).toBeNull();
    expect(account.custom_name).toBe("");
    expect(account.hide).toBe(false);
    expect(account.label).toEqual({});
    expect(account.graphOptions).toEqual({ useSnapshots: true, useTransactions: true });
  });
});

describe("translateTransaction", () => {
  test("translates transaction with correct fields", () => {
    const sfTransaction = createMockSimpleFinTransaction();
    const sfAccount = createMockSimpleFinAccount();

    const transaction = translateTransaction(sfTransaction, sfAccount);

    expect(transaction.transaction_id).toBe("txn-001");
    expect(transaction.amount).toBe(-50);
    expect(transaction.name).toBe("Coffee Shop");
    expect(transaction.merchant_name).toBe("Local Coffee");
    expect(transaction.account_id).toBe("acc-001");
    expect(transaction.pending).toBe(false);
  });

  test("converts unix timestamps to datetime strings", () => {
    const sfTransaction = createMockSimpleFinTransaction({
      posted: 1704153600,
      transacted_at: 1704150000,
    });
    const sfAccount = createMockSimpleFinAccount();

    const transaction = translateTransaction(sfTransaction, sfAccount);

    // Check that dates are formatted as datetime strings
    expect(transaction.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(transaction.datetime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(transaction.authorized_date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(transaction.authorized_datetime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("preserves memo in label", () => {
    const sfTransaction = createMockSimpleFinTransaction({ memo: "Test memo" });
    const sfAccount = createMockSimpleFinAccount();

    const transaction = translateTransaction(sfTransaction, sfAccount);

    expect(transaction.label).toEqual({ memo: "Test memo" });
  });

  test("handles positive amount", () => {
    const sfTransaction = createMockSimpleFinTransaction({ amount: "100.00" });
    const sfAccount = createMockSimpleFinAccount();

    const transaction = translateTransaction(sfTransaction, sfAccount);

    expect(transaction.amount).toBe(100);
  });

  test("sets empty location object", () => {
    const sfTransaction = createMockSimpleFinTransaction();
    const sfAccount = createMockSimpleFinAccount();

    const transaction = translateTransaction(sfTransaction, sfAccount);

    expect(transaction.location).toEqual({
      address: null,
      city: null,
      region: null,
      postal_code: null,
      country: null,
      lat: null,
      lon: null,
      store_number: null,
    });
  });
});

describe("translateInvestmentTransaction", () => {
  test("translates investment transaction correctly", () => {
    const sfTransaction = createMockSimpleFinTransaction({
      id: "inv-txn-001",
      amount: "500.00",
      description: "Stock Purchase",
    });
    const sfAccount = createMockSimpleFinAccount();

    const invTransaction = translateInvestmentTransaction(sfTransaction, sfAccount);

    expect(invTransaction.investment_transaction_id).toBe("inv-txn-001");
    expect(invTransaction.amount).toBe(500);
    expect(invTransaction.quantity).toBe(1);
    expect(invTransaction.price).toBe(500);
    expect(invTransaction.name).toBe("Stock Purchase");
    expect(invTransaction.account_id).toBe("acc-001");
    expect(invTransaction.type).toBe(InvestmentTransactionType.Buy);
    expect(invTransaction.subtype).toBe(InvestmentTransactionSubtype.Buy);
  });

  test("defaults security_id to null", () => {
    const sfTransaction = createMockSimpleFinTransaction();
    const sfAccount = createMockSimpleFinAccount();

    const invTransaction = translateInvestmentTransaction(sfTransaction, sfAccount);

    expect(invTransaction.security_id).toBeNull();
  });

  test("has empty label object", () => {
    const sfTransaction = createMockSimpleFinTransaction();
    const sfAccount = createMockSimpleFinAccount();

    const invTransaction = translateInvestmentTransaction(sfTransaction, sfAccount);

    expect(invTransaction.label).toEqual({});
  });
});

describe("translateHolding", () => {
  test("translates holding and creates security", () => {
    const sfHolding = createMockSimpleFinHolding();
    const sfAccount = createMockSimpleFinAccount();

    const { security, holding } = translateHolding(sfHolding, sfAccount);

    // Security assertions - security_id should be a valid UUID and linked to holding
    expect(security.security_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(security.ticker_symbol).toBe("AAPL");
    expect(security.name).toBe("Apple Inc.");
    expect(security.iso_currency_code).toBe("USD");
    expect(security.close_price).toBe(120); // 1200 / 10

    // Holding assertions - security_id should match the created security
    expect(holding.account_id).toBe("acc-001");
    expect(holding.security_id).toBe(security.security_id);
    expect(holding.holding_id).toBe("hold-001");
    expect(holding.institution_value).toBe(1200);
    expect(holding.cost_basis).toBe(1000);
    expect(holding.quantity).toBe(10);
  });

  test("uses holding currency when provided", () => {
    const sfHolding = createMockSimpleFinHolding({ currency: "EUR" });
    const sfAccount = createMockSimpleFinAccount({ currency: "USD" });

    const { security, holding } = translateHolding(sfHolding, sfAccount);

    expect(security.iso_currency_code).toBe("EUR");
    expect(holding.iso_currency_code).toBe("EUR");
  });

  test("falls back to account currency when holding currency is empty", () => {
    const sfHolding = createMockSimpleFinHolding({ currency: "" });
    const sfAccount = createMockSimpleFinAccount({ currency: "GBP" });

    const { security, holding } = translateHolding(sfHolding, sfAccount);

    expect(security.iso_currency_code).toBe("GBP");
    expect(holding.iso_currency_code).toBe("GBP");
  });

  test("calculates close_price from market_value and shares", () => {
    const sfHolding = createMockSimpleFinHolding({
      market_value: "500.00",
      shares: "20",
    });
    const sfAccount = createMockSimpleFinAccount();

    const { security } = translateHolding(sfHolding, sfAccount);

    expect(security.close_price).toBe(25); // 500 / 20
  });

  test("formats close_price_as_of as date string", () => {
    const sfHolding = createMockSimpleFinHolding({
      created: 1704067200, // 2024-01-01T00:00:00Z
    });
    const sfAccount = createMockSimpleFinAccount();

    const { security, holding } = translateHolding(sfHolding, sfAccount);

    expect(security.close_price_as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(holding.institution_price_as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("sets security defaults to null", () => {
    const sfHolding = createMockSimpleFinHolding();
    const sfAccount = createMockSimpleFinAccount();

    const { security } = translateHolding(sfHolding, sfAccount);

    expect(security.isin).toBeNull();
    expect(security.cusip).toBeNull();
    expect(security.sedol).toBeNull();
    expect(security.type).toBeNull();
    expect(security.sector).toBeNull();
    expect(security.industry).toBeNull();
  });
});
