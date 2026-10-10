import { describe, test, expect } from "bun:test";
import {
  AccountType,
  AccountSubtype,
  InvestmentTransactionType,
  InvestmentTransactionSubtype,
} from "plaid";
import { getAccountBalance, getBalanceData, getDisplayBalance } from "./accounts";
import {
  Account,
  AccountDictionary,
  AccountSnapshotDictionary,
  BalanceData,
  HoldingSnapshotDictionary,
  InvestmentTransaction,
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

// On a cold load, `getDisplayBalance` must distinguish "history still loading"
// (fall back to the live balance, like future dates) from "load complete,
// genuinely no record" (fall back to 0). Without the distinction a not-yet-
// streamed past month renders every account as $0 and feeds a bogus
// net-worth collapse into the Accounts table and balance charts.
describe("getDisplayBalance cold-load past-balance flash", () => {
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

  test("missing past balance falls back to 0 once the load is complete", () => {
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

// An investment balance is quantity times TODAY's price, while a transaction
// only ever carries the price of its own day. Reconstructing history by
// subtracting the second from the first leaves neither a past market value
// nor a cost basis, and the gap widens with every month of price movement —
// on a four-year 401(k) the earliest month came out near the account's whole
// present value rather than near its first contribution.
describe("investment balance history from transactions", () => {
  const ACCOUNT_ID = "inv1";
  const SHARES = 10;

  const makeAccount = (current: number) =>
    new Account({
      account_id: ACCOUNT_ID,
      type: AccountType.Investment,
      balances: {
        current,
        available: 0,
        limit: null,
        iso_currency_code: "USD",
        unofficial_currency_code: null,
      },
    });

  const contribution = (date: string, price: number, quantity = SHARES) =>
    new InvestmentTransaction({
      investment_transaction_id: `t-${date}`,
      account_id: ACCOUNT_ID,
      security_id: "sec1",
      date,
      name: "Contributions",
      quantity,
      amount: price * quantity,
      price,
      type: quantity >= 0 ? InvestmentTransactionType.Buy : InvestmentTransactionType.Sell,
      subtype:
        quantity >= 0
          ? InvestmentTransactionSubtype.Contribution
          : InvestmentTransactionSubtype.Withdrawal,
    });

  const balancesFor = (current: number, txns: InvestmentTransaction[]) =>
    getBalanceData(
      new AccountDictionary([[ACCOUNT_ID, makeAccount(current)]]),
      new AccountSnapshotDictionary(),
      new HoldingSnapshotDictionary(),
      new TransactionDictionary(),
      new InvestmentTransactionDictionary(txns.map((t) => [t.id, t])),
    );

  const at = (balanceData: BalanceData, yearMonth: string) =>
    balanceData.get(ACCOUNT_ID, new Date(`${yearMonth}-15`));

  // $100 bought at $10, then the price doubles and $100 more is bought. The
  // account is now worth $300 (20 shares at $20) but only $200 ever went in,
  // and the first month must read the $100 it cost — not the $300 it grew to,
  // and not $300 minus the two purchases either.
  test("a month's value is what went in by then, not today's balance minus flows", () => {
    const balanceData = balancesFor(300, [
      contribution("2022-01-15", 10),
      contribution("2022-02-15", 20, 5),
    ]);
    expect(at(balanceData, "2022-01")).toBeCloseTo(100, 2);
    expect(at(balanceData, "2022-02")).toBeCloseTo(200, 2);
  });

  // The transaction tier is the chart's last resort, so nothing may make it
  // claim a month that precedes every transaction the account has.
  test("no month is invented before the first transaction", () => {
    const balanceData = balancesFor(300, [
      contribution("2022-04-15", 10),
      contribution("2022-05-15", 10),
    ]);
    expect(at(balanceData, "2022-03")).toBeUndefined();
    expect(at(balanceData, "2022-04")).toBeCloseTo(100, 2);
  });

  // A rollover leaves the withdrawal on this account and the deposit on one
  // this never sees, so the sales can exceed every purchase in the window.
  test("selling more than the window ever bought floors at zero, never negative", () => {
    const balanceData = balancesFor(0, [
      contribution("2022-01-15", 10),
      contribution("2022-02-15", 10, -50),
    ]);
    expect(at(balanceData, "2022-01")).toBeCloseTo(100, 2);
    expect(at(balanceData, "2022-02")).toBe(0);
  });

  // Cash does not appreciate, so the walk back from the reported balance
  // reconstructs a depository account exactly. That path is untouched.
  test("a regular transaction still reconstructs backward from the reported balance", () => {
    const accountId = "dep1";
    const account = new Account({
      account_id: accountId,
      type: AccountType.Depository,
      balances: {
        current: 900,
        available: 900,
        limit: null,
        iso_currency_code: "USD",
        unofficial_currency_code: null,
      },
    });
    const balanceData = getBalanceData(
      new AccountDictionary([[accountId, account]]),
      new AccountSnapshotDictionary(),
      new HoldingSnapshotDictionary(),
      new TransactionDictionary(),
      new InvestmentTransactionDictionary(),
    );
    // With no transactions at all the account still reports its live balance.
    expect(balanceData.get(accountId, new Date())).toBe(900);
  });
});