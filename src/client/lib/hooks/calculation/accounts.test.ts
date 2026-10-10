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

  // Shares bought before the fetched window are sold inside it, so the sale
  // takes out more basis than the window ever recorded. The basis bottoms out
  // at nothing rather than going negative, and the proceeds are still real
  // money the account now holds.
  test("a sale larger than the window's purchases keeps its proceeds and no negative basis", () => {
    const balanceData = balancesFor(500, [
      contribution("2022-01-15", 10),
      contribution("2022-02-15", 10, -50),
    ]);
    expect(at(balanceData, "2022-01")).toBeCloseTo(100, 2);
    expect(at(balanceData, "2022-02")).toBeCloseTo(500, 2);
  });

  // Half the shares go, so half the basis goes — $50 of the $100, not the
  // $150 of proceeds, which would wipe out a position still half held. The
  // proceeds land as cash, so the account reads $50 of shares plus $150.
  test("a partial sale removes basis in proportion to shares, not proceeds", () => {
    const balanceData = balancesFor(300, [
      contribution("2022-01-15", 10),
      contribution("2022-03-15", 30, -5),
    ]);
    expect(at(balanceData, "2022-01")).toBeCloseTo(100, 2);
    expect(at(balanceData, "2022-03")).toBeCloseTo(200, 2);
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

  // A broker's sweep is the same money the cash row already reports, so
  // counting its `price: 1` buy as a position doubles the account.
  test("a cash sweep is not a second position on top of the cash it holds", () => {
    const deposit = new InvestmentTransaction({
      investment_transaction_id: "cash-in",
      account_id: ACCOUNT_ID,
      security_id: null,
      date: "2022-01-10",
      name: "Deposit",
      quantity: 0,
      amount: -1000,
      price: 0,
      type: InvestmentTransactionType.Cash,
      subtype: InvestmentTransactionSubtype.Deposit,
    });
    const sweep = contribution("2022-01-11", 1, 1000);
    expect(at(balancesFor(1000, [deposit, sweep]), "2022-01")).toBeCloseTo(1000, 2);
  });

  // Each security carries its own average cost. Pooling them lets one
  // security's sale draw down basis built by shares it never touched — the
  // prices here differ precisely so the pooled average would not match.
  test("two securities keep separate average costs", () => {
    const balanceData = balancesFor(600, [
      // sec1: 10 shares at $10 = $100.
      contribution("2022-01-15", 10, 10),
      // sec2: 10 shares at $50 = $500. Pooled, the average would be $30.
      new InvestmentTransaction({
        investment_transaction_id: "other-buy",
        account_id: ACCOUNT_ID,
        security_id: "sec2",
        date: "2022-01-16",
        name: "Contributions",
        quantity: 10,
        amount: 500,
        price: 50,
        type: InvestmentTransactionType.Buy,
        subtype: InvestmentTransactionSubtype.Contribution,
      }),
      // Half of sec1 goes: $50 of basis at sec1's own average, not $150 at
      // the pooled one. $200 of proceeds land as cash either way.
      contribution("2022-02-15", 40, -5),
    ]);
    expect(at(balanceData, "2022-02")).toBeCloseTo(750, 2);
  });

  // Cash can run past every purchase on its own, with no position to clamp.
  test("a withdrawal exceeding every deposit floors the account at zero", () => {
    const out = new InvestmentTransaction({
      investment_transaction_id: "cash-out",
      account_id: ACCOUNT_ID,
      security_id: null,
      date: "2022-02-10",
      name: "Withdrawal",
      quantity: 0,
      amount: 1000,
      price: 0,
      type: InvestmentTransactionType.Cash,
      subtype: InvestmentTransactionSubtype.Withdrawal,
    });
    expect(at(balancesFor(0, [out]), "2022-02")).toBe(0);
  });

  // A dictionary yields insertion order, which is whatever the API returned.
  // Average cost is path-dependent, so the replay has to be chronological.
  test("transactions replay in date order whatever order they arrive in", () => {
    const buy = contribution("2022-01-15", 10, 10);
    const sell = contribution("2022-03-15", 30, -5);
    const inOrder = at(balancesFor(300, [buy, sell]), "2022-03");
    const reversed = at(balancesFor(300, [sell, buy]), "2022-03");
    expect(inOrder).toBeCloseTo(200, 2);
    expect(reversed).toBeCloseTo(200, 2);
  });

  test("a transaction dated in the future claims no month", () => {
    const balanceData = balancesFor(100, [
      contribution("2022-01-15", 10),
      contribution("2099-01-15", 10),
    ]);
    expect(at(balanceData, "2099-01")).toBeUndefined();
    expect(at(balanceData, "2022-01")).toBeCloseTo(100, 2);
  });

  // A fee is money leaving the account, not a position being opened. Folding
  // it as a buy leaves the account reporting what it held before paying.
  test("a fee leaves the account rather than opening a position", () => {
    const deposit = new InvestmentTransaction({
      investment_transaction_id: "cash-in",
      account_id: ACCOUNT_ID,
      security_id: null,
      date: "2022-01-10",
      name: "Deposit",
      quantity: 0,
      amount: -1000,
      price: 0,
      type: InvestmentTransactionType.Cash,
      subtype: InvestmentTransactionSubtype.Deposit,
    });
    const fee = new InvestmentTransaction({
      investment_transaction_id: "fee",
      account_id: ACCOUNT_ID,
      security_id: null,
      date: "2022-01-20",
      name: "Account fee",
      quantity: 0,
      amount: 100,
      price: 0,
      type: InvestmentTransactionType.Fee,
      subtype: InvestmentTransactionSubtype.AccountFee,
    });
    expect(at(balancesFor(900, [deposit, fee]), "2022-01")).toBeCloseTo(900, 2);
  });

  // Not every provider carries the two legs of a trade in two rows, and not
  // every provider signs them the way Plaid does: one mints a single row per
  // movement, as a buy of one unit priced at the whole amount, signed
  // positive when the money arrives. Reading the cash leg's direction off
  // that sign hands such an account a credit for every withdrawal, which
  // flatlines the balance at gross all-time inflow.
  const singleRowMovement = (date: string, amount: number) =>
    new InvestmentTransaction({
      investment_transaction_id: `single-${date}`,
      account_id: ACCOUNT_ID,
      security_id: null,
      date,
      name: "Movement",
      quantity: 1,
      amount,
      price: amount,
      type: InvestmentTransactionType.Buy,
      subtype: InvestmentTransactionSubtype.Buy,
    });

  test("a provider that carries both legs in one row is not charged twice", () => {
    const balanceData = balancesFor(700, [
      singleRowMovement("2022-01-10", 1000),
      singleRowMovement("2022-02-10", -500),
      singleRowMovement("2022-03-10", 200),
    ]);
    expect(at(balanceData, "2022-01")).toBeCloseTo(1000, 2);
    expect(at(balanceData, "2022-02")).toBeCloseTo(500, 2);
    expect(at(balanceData, "2022-03")).toBeCloseTo(700, 2);
  });

  test("a withdrawal of money this never saw does not bury the deposits after it", () => {
    const withdrawal = new InvestmentTransaction({
      investment_transaction_id: "cash-out",
      account_id: ACCOUNT_ID,
      security_id: null,
      date: "2022-01-05",
      name: "Withdrawal",
      quantity: 0,
      amount: 1000,
      price: 0,
      type: InvestmentTransactionType.Cash,
      subtype: InvestmentTransactionSubtype.Withdrawal,
    });
    const deposit = new InvestmentTransaction({
      investment_transaction_id: "cash-in",
      account_id: ACCOUNT_ID,
      security_id: null,
      date: "2022-02-10",
      name: "Deposit",
      quantity: 0,
      amount: -600,
      price: 0,
      type: InvestmentTransactionType.Cash,
      subtype: InvestmentTransactionSubtype.Deposit,
    });
    const balanceData = balancesFor(600, [withdrawal, deposit]);
    expect(at(balanceData, "2022-01")).toBeCloseTo(0, 2);
    expect(at(balanceData, "2022-02")).toBeCloseTo(600, 2);
  });

  // Rows sharing a date keep the order they arrived in, so the fold has to
  // land on the same total either way round.
  test("a buy and a sale on one day read the same in either arrival order", () => {
    const sameDay = (id: string, quantity: number) =>
      new InvestmentTransaction({
        investment_transaction_id: id,
        account_id: ACCOUNT_ID,
        security_id: "sec1",
        date: "2022-01-10",
        name: "Same day",
        quantity,
        amount: 10 * quantity,
        price: 10,
        type: quantity >= 0 ? InvestmentTransactionType.Buy : InvestmentTransactionType.Sell,
        subtype:
          quantity >= 0 ? InvestmentTransactionSubtype.Buy : InvestmentTransactionSubtype.Sell,
      });
    const buy = sameDay("same-buy", 10);
    const sale = sameDay("same-sale", -5);
    // Ten shares bought at $10 and half of them sold at cost: $50 of basis
    // left holding $50 of proceeds, whichever row the fold reaches first.
    expect(at(balancesFor(150, [buy, sale]), "2022-01")).toBeCloseTo(100, 2);
    expect(at(balancesFor(150, [sale, buy]), "2022-01")).toBeCloseTo(100, 2);
  });

  // A month takes the state after everything in it, so a later row in the
  // same month has to win over an earlier one.
  test("a month reads the state after its last transaction, not its first", () => {
    const balanceData = balancesFor(300, [
      contribution("2022-01-05", 10),
      contribution("2022-01-25", 20, 10),
    ]);
    expect(at(balanceData, "2022-01")).toBeCloseTo(300, 2);
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