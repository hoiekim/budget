import { describe, test, expect } from "bun:test";
import {
  AccountType,
  AccountSubtype,
  InvestmentTransactionType,
  InvestmentTransactionSubtype,
} from "plaid";
import { getYearMonthString } from "common";
import { getAccountBalance, getBalanceData, getDisplayBalance } from "./accounts";
import {
  Account,
  AccountDictionary,
  AccountSnapshotDictionary,
  BalanceData,
  HoldingSnapshotDictionary,
  InvestmentTransaction,
  InvestmentTransactionDictionary,
  Transaction,
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

// An investment balance is quantity times today's price; a transaction only
// carries the price of its own day. Neither stands in for the other.
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

  // 20 shares now worth $300, but only $200 ever went in to buy them.
  test("a month's value is what went in by then, not today's balance minus flows", () => {
    const balanceData = balancesFor(300, [
      contribution("2022-01-15", 10),
      contribution("2022-02-15", 20, 5),
    ]);
    expect(at(balanceData, "2022-01")).toBeCloseTo(100, 2);
    expect(at(balanceData, "2022-02")).toBeCloseTo(200, 2);
  });

  test("no month is invented before the first transaction", () => {
    const balanceData = balancesFor(300, [
      contribution("2022-04-15", 10),
      contribution("2022-05-15", 10),
    ]);
    expect(at(balanceData, "2022-03")).toBeUndefined();
    expect(at(balanceData, "2022-04")).toBeCloseTo(100, 2);
  });

  // A rollover leaves the withdrawal here and the deposit on an account this
  // never sees, so sales can exceed every purchase in the window.
  test("selling more than the window ever bought floors at zero, never negative", () => {
    const balanceData = balancesFor(0, [
      contribution("2022-01-15", 10),
      contribution("2022-02-15", 10, -50),
    ]);
    expect(at(balanceData, "2022-01")).toBeCloseTo(100, 2);
    expect(at(balanceData, "2022-02")).toBe(0);
  });

  // A profitable partial sale takes out half the shares, so it takes out half
  // the basis — not the whole of it, which is what subtracting the proceeds
  // from the cost would do while the position is still held.
  test("a partial sale removes basis in proportion to shares, not proceeds", () => {
    const balanceData = balancesFor(150, [
      contribution("2022-01-15", 10),
      contribution("2022-03-15", 30, -5),
    ]);
    expect(at(balanceData, "2022-01")).toBeCloseTo(100, 2);
    expect(at(balanceData, "2022-03")).toBeCloseTo(50, 2);
  });

  // Cash carries its value in `amount`, not in shares, so a share-count
  // reading drops it entirely and an account holding only cash reads zero.
  test("a cash transaction counts by its amount, which no share count carries", () => {
    const deposit = new InvestmentTransaction({
      investment_transaction_id: "cash-in",
      account_id: ACCOUNT_ID,
      security_id: null,
      date: "2022-01-15",
      name: "Deposit",
      quantity: 0,
      // Plaid signs `amount` positive when cash LEAVES, so an arrival is negative.
      amount: -1000,
      price: 0,
      type: InvestmentTransactionType.Cash,
      subtype: InvestmentTransactionSubtype.Deposit,
    });
    expect(at(balancesFor(1000, [deposit]), "2022-01")).toBeCloseTo(1000, 2);
  });

  test("fees paid to acquire a position count toward what it cost", () => {
    const withFee = contribution("2022-01-15", 10);
    withFee.fees = 10;
    expect(at(balancesFor(110, [withFee]), "2022-01")).toBeCloseTo(110, 2);
  });

  // The snapshot tier normally writes the live balance over the current
  // month, so this guard only carries weight once a user turns that tier off
  // — and then it is the only thing between "right now" and a cost basis.
  test("the current month keeps the live balance even with the snapshot tier off", () => {
    const thisMonth = getYearMonthString(new Date());
    const account = makeAccount(5000);
    account.graphOptions = {
      useSnapshots: false,
      useHoldingSnapshots: false,
      useTransactions: true,
    };
    // The 1st, not the 15th: a date later in the current month is a future
    // transaction on most days of the month and gets filtered out before it
    // can reach the guard under test.
    const bought = contribution(`${thisMonth}-01`, 10);
    const balanceData = getBalanceData(
      new AccountDictionary([[ACCOUNT_ID, account]]),
      new AccountSnapshotDictionary(),
      new HoldingSnapshotDictionary(),
      new TransactionDictionary(),
      new InvestmentTransactionDictionary([[bought.id, bought]]),
    );
    // The position cost 100; the account is actually worth 5000 today.
    expect(balanceData.get(ACCOUNT_ID, new Date())).toBe(5000);
  });

  // Cash does not appreciate, so the walk back from the reported balance
  // reconstructs a depository account exactly. That path is untouched.
  describe("the depository path is unchanged", () => {
    const DEPOSITORY_ID = "dep1";

    const depositoryBalances = (txns: Transaction[]) =>
      getBalanceData(
        new AccountDictionary([
          [
            DEPOSITORY_ID,
            new Account({
              account_id: DEPOSITORY_ID,
              type: AccountType.Depository,
              balances: {
                current: 900,
                available: 900,
                limit: null,
                iso_currency_code: "USD",
                unofficial_currency_code: null,
              },
            }),
          ],
        ]),
        new AccountSnapshotDictionary(),
        new HoldingSnapshotDictionary(),
        new TransactionDictionary(txns.map((t) => [t.id, t])),
        new InvestmentTransactionDictionary(),
      );

    const spend = (date: string, amount: number, authorized_date: string | null = null) =>
      new Transaction({
        transaction_id: `s-${date}`,
        account_id: DEPOSITORY_ID,
        date,
        authorized_date,
        amount,
        name: "Purchase",
      });

    // $100 spent in March against a $900 balance today: February held $1000,
    // March holds what is left. The spend is keyed to the month BEFORE its
    // own, which is what makes the backward walk land on end-of-month values.
    test("a spend raises every month before it by what was spent", () => {
      const balanceData = depositoryBalances([spend("2022-03-10", 100)]);
      expect(balanceData.get(DEPOSITORY_ID, new Date("2022-02-15"))).toBeCloseTo(1000, 2);
      expect(balanceData.get(DEPOSITORY_ID, new Date("2022-03-15"))).toBeCloseTo(900, 2);
    });

    // `authorized_date` is when the money actually moved; `date` can post days
    // later and fall in the next month entirely.
    test("authorized_date wins over the posting date when both are present", () => {
      const balanceData = depositoryBalances([spend("2022-04-02", 100, "2022-03-28")]);
      expect(balanceData.get(DEPOSITORY_ID, new Date("2022-02-15"))).toBeCloseTo(1000, 2);
      expect(balanceData.get(DEPOSITORY_ID, new Date("2022-03-15"))).toBeCloseTo(900, 2);
    });
  });
});