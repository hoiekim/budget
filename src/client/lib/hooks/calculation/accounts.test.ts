import { describe, test, expect } from "bun:test";
import { AccountType, AccountSubtype } from "plaid";
import { getAccountBalance, getDisplayBalance, getBalanceData } from "./accounts";
import {
  Account,
  AccountDictionary,
  AccountSnapshot,
  AccountSnapshotDictionary,
  BalanceData,
  HoldingSnapshot,
  HoldingSnapshotDictionary,
  InvestmentTransactionDictionary,
  TransactionDictionary,
} from "client";

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

// Regression coverage for the tier-1-vs-tier-2 merge in getBalanceData. For an
// investment account a Plaid `account_balance` snapshot can report only the
// settled-cash sleeve while the holdings-inclusive total lives in the same
// month's `holding` snapshot; tier 1 must not override a larger tier-2 total
// (a false V-crater on the account balance graph).
describe("getBalanceData tier-1/tier-2 reconciliation for investment accounts", () => {
  // getBalanceData internally compares snapshot dates against the real `new
  // Date()`, so fixtures must sit in the past. BalanceHistory buckets by
  // year-month, so any day of MONTH is retrievable via a same-month read.
  const MONTH = "2025-06";
  const readAt = new Date(`${MONTH}-15`);

  const buildAccountSnapshots = (account: Account, current: number) => {
    const snapshots = new AccountSnapshotDictionary();
    const snapshot = new AccountSnapshot({
      snapshot: { date: `${MONTH}-15T00:00:00.000Z` },
      account: { ...account, balances: { ...account.balances, current } },
    });
    snapshots.set(snapshot.id, snapshot);
    return snapshots;
  };

  const buildHoldingSnapshots = (accountId: string, institutionValue: number) => {
    const snapshots = new HoldingSnapshotDictionary();
    const snapshot = new HoldingSnapshot({
      snapshot: { date: `${MONTH}-15T00:00:00.000Z` },
      holding: {
        account_id: accountId,
        security_id: "sec1",
        holding_id: "hold1",
        institution_value: institutionValue,
      },
    });
    snapshots.set(snapshot.id, snapshot);
    return snapshots;
  };

  const singleAccount = (account: Account) => {
    const accounts = new AccountDictionary();
    accounts.set(account.id, account);
    return accounts;
  };

  const merge = (
    accounts: AccountDictionary,
    accountSnapshots: AccountSnapshotDictionary,
    holdingSnapshots: HoldingSnapshotDictionary,
  ) =>
    getBalanceData(
      accounts,
      accountSnapshots,
      holdingSnapshots,
      new TransactionDictionary(),
      new InvestmentTransactionDictionary(),
    );

  test("investment: a cash-only account_balance snapshot does not override the larger holdings total", () => {
    const account = new Account({ account_id: "inv1", type: AccountType.Investment });
    const merged = merge(
      singleAccount(account),
      buildAccountSnapshots(account, 500), // cash sleeve only
      buildHoldingSnapshots(account.id, 100_000), // holdings-inclusive total
    );
    // Pre-fix this returned 500 (the cratered cash-only figure).
    expect(merged.get(account.id, readAt)).toBe(100_000);
  });

  test("investment: a holdings-inclusive account_balance snapshot still wins when it is the larger figure", () => {
    const account = new Account({ account_id: "inv2", type: AccountType.Investment });
    const merged = merge(
      singleAccount(account),
      buildAccountSnapshots(account, 100_000), // full portfolio total
      buildHoldingSnapshots(account.id, 80_000), // stale/partial holdings
    );
    expect(merged.get(account.id, readAt)).toBe(100_000);
  });

  test("depository: account_balance snapshot always wins (holdings reconciliation is investment-only)", () => {
    const account = new Account({ account_id: "dep1", type: AccountType.Depository });
    const merged = merge(
      singleAccount(account),
      buildAccountSnapshots(account, 500),
      buildHoldingSnapshots(account.id, 100_000),
    );
    expect(merged.get(account.id, readAt)).toBe(500);
  });
});