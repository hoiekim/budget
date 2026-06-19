import { describe, test, expect } from "bun:test";
import { AccountType, AccountSubtype } from "plaid";
import { getAccountBalance, getDisplayBalance } from "./accounts";
import { Account, BalanceData } from "client";

describe("getAccountBalance", () => {
  test("should return current balance for depository accounts", () => {
    const account = new Account({
      account_id: "acc1",
      type: AccountType.Depository,
      balances: { current: 1000, available: 500, limit: null, iso_currency_code: "USD", unofficial_currency_code: null },
    });
    expect(getAccountBalance(account)).toBe(1000);
  });

  test("should return current balance for credit accounts", () => {
    const account = new Account({
      account_id: "acc1",
      type: AccountType.Credit,
      balances: { current: 500, available: 1500, limit: 2000, iso_currency_code: "USD", unofficial_currency_code: null },
    });
    expect(getAccountBalance(account)).toBe(500);
  });

  test("should return only current for investment accounts (available is already included in current)", () => {
    const account = new Account({
      account_id: "acc1",
      type: AccountType.Investment,
      balances: { current: 1000, available: 500, limit: null, iso_currency_code: "USD", unofficial_currency_code: null },
    });
    // Plaid's `available` for investment accounts represents the cash component
    // which is already included in `current`. Adding both would double-count cash.
    expect(getAccountBalance(account)).toBe(1000);
  });

  test("should return only current for crypto exchange accounts", () => {
    const account = new Account({
      account_id: "acc1",
      type: AccountType.Investment,
      subtype: AccountSubtype.CryptoExchange,
      balances: { current: 1000, available: 500, limit: null, iso_currency_code: "USD", unofficial_currency_code: null },
    });
    expect(getAccountBalance(account)).toBe(1000);
  });

  test("should handle zero balances", () => {
    const account = new Account({
      account_id: "acc1",
      type: AccountType.Depository,
      balances: { current: 0, available: 0, limit: null, iso_currency_code: "USD", unofficial_currency_code: null },
    });
    expect(getAccountBalance(account)).toBe(0);
  });

  test("should handle null/undefined balance values", () => {
    const account = new Account({
      account_id: "acc1",
      type: AccountType.Investment,
      balances: { current: null as unknown as number, available: null as unknown as number, limit: null, iso_currency_code: "USD", unofficial_currency_code: null },
    });
    // When values are null/undefined, they become 0
    expect(getAccountBalance(account)).toBe(0);
  });
});

// Regression coverage for #510: on a cold load, navigating to a past month
// rendered every not-yet-streamed account as $0.00 — feeding a bogus
// net-worth collapse into the Accounts table, the "All Accounts" headline,
// and the balance charts — before self-healing once the backfill reached
// that month. getDisplayBalance now distinguishes "history still loading"
// (fall back to the live balance, like future dates) from "load complete,
// genuinely no record" (fall back to 0, preserving #428).
describe("getDisplayBalance (#510 cold-load past-balance flash)", () => {
  const LIVE = 1000;
  const RECORDED = 250;
  const makeAccount = () =>
    new Account({
      account_id: "acc1",
      type: AccountType.Investment,
      balances: {
        current: LIVE,
        available: 0,
        limit: null,
        iso_currency_code: "USD",
        unofficial_currency_code: null,
      },
    });

  const today = new Date("2026-06-15");
  const pastDate = new Date("2026-03-15");
  const futureDate = new Date("2026-12-15");

  test("returns the recorded balance when one exists, regardless of load state", () => {
    const account = makeAccount();
    const balanceData = new BalanceData();
    balanceData.set(account.id, pastDate, RECORDED);
    expect(getDisplayBalance(balanceData, account, pastDate, today, true)).toBe(RECORDED);
    expect(getDisplayBalance(balanceData, account, pastDate, today, false)).toBe(RECORDED);
  });

  test("a recorded zero is honored (not treated as missing) once loaded", () => {
    const account = makeAccount();
    const balanceData = new BalanceData();
    balanceData.set(account.id, pastDate, 0);
    expect(getDisplayBalance(balanceData, account, pastDate, today, false)).toBe(0);
  });

  test("missing past balance falls back to the LIVE balance while history is loading", () => {
    const account = makeAccount();
    const balanceData = new BalanceData();
    expect(getDisplayBalance(balanceData, account, pastDate, today, true)).toBe(LIVE);
  });

  test("missing past balance falls back to 0 once the load is complete (#428 preserved)", () => {
    const account = makeAccount();
    const balanceData = new BalanceData();
    expect(getDisplayBalance(balanceData, account, pastDate, today, false)).toBe(0);
  });

  test("missing future balance falls back to the LIVE balance even when not loading", () => {
    const account = makeAccount();
    const balanceData = new BalanceData();
    expect(getDisplayBalance(balanceData, account, futureDate, today, false)).toBe(LIVE);
  });
});

// Note: getBalanceData tests require mocking the environment or using integration tests
// because the Dictionary class disables set() in server/test environments.
// These tests should be run as part of e2e testing.