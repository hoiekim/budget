import { useCallback, useMemo } from "react";
import {
  Account,
  AccountDictionary,
  AccountSnapshot,
  AccountSnapshotDictionary,
  Data,
  InvestmentTransaction,
  InvestmentTransactionDictionary,
  Transaction,
  TransactionDictionary,
  ViewDate,
} from "common";
import { GraphInput, useAppContext } from "client";
import { AccountSubtype, AccountType } from "plaid";

export const getAccountBalance = (account: Account) => {
  const balanceCurrent = account.balances.current || 0;
  const balanceAvailalbe = account.balances.available || 0;
  let value = 0;
  if (account.type === AccountType.Investment) {
    if (account.subtype === AccountSubtype.CryptoExchange) value = balanceCurrent;
    else value = balanceCurrent + balanceAvailalbe;
  } else {
    value = balanceCurrent;
  }
  return value;
};

/**
 * Balance history stored by `accountId` and `span`. `span` is 0-indexed time interval
 * where 0 is today, 1 is one month(or year) ago, 2 is two month(or year) ago, etc.
 * @example const balanceAmount = balanceData.get(accountId, span);
 */
class BalanceData {
  private data = new Map<string, number[]>();

  get size() {
    return this.data.size;
  }

  length = 0;

  set = (accountId: string, span: number, amount: number) => {
    if (!this.data.has(accountId)) this.data.set(accountId, []);
    const accountData = this.data.get(accountId)!;
    accountData[span] = amount;
    this.length = Math.max(this.length, accountData.length);
  };

  get(accountId: string, span: number): number | undefined;
  get(accountId: string): number[];
  get(accountId: string, span?: number) {
    const accountData = this.data.get(accountId);
    if (span === undefined) return accountData || [];
    if (!accountData) return undefined;
    return accountData[span];
  }

  /**
   * Add amount to specified position. If data doesn't exist, assume it was 0.
   */
  add = (accountId: string, span: number, amount: number) => {
    const existing = this.get(accountId, span) || 0;
    this.set(accountId, span, existing + amount);
  };

  forEach = this.data.forEach;
}

const getBalanceDataFromTransactions = (
  accounts: AccountDictionary,
  transactions: TransactionDictionary,
  investmentTransactions: InvestmentTransactionDictionary,
  viewDate: ViewDate,
): BalanceData => {
  const balanceData = new BalanceData();

  const today = new Date();
  const todaySpan = viewDate.getSpanFrom(today);
  accounts.forEach((a) => balanceData.set(a.id, todaySpan, getAccountBalance(a)));

  // first aggregate transactions to sum amounts for each period
  const translate = (t: Transaction | InvestmentTransaction) => {
    const authorized_date = "authorized_date" in t ? t.authorized_date : undefined;
    const { account_id, date, amount } = t;
    if (!accounts.has(account_id)) return;
    const transactionDate = new Date(authorized_date || date);
    if (today < transactionDate) return;
    const span = viewDate.getSpanFrom(transactionDate) + 1;
    if ("price" in t && "quantity" in t) {
      const { price, quantity } = t as InvestmentTransaction;
      balanceData.add(account_id, span, -(price * quantity));
    } else {
      balanceData.add(account_id, span, amount);
    }
  };

  transactions.forEach(translate);
  investmentTransactions.forEach(translate);

  // then incrementally add them up
  for (const [accountId] of accounts) {
    for (let i = todaySpan + 1; i < balanceData.get(accountId).length; i++) {
      const previousBalance = balanceData.get(accountId, i - 1)!;
      balanceData.add(accountId, i, previousBalance);
    }
  }

  return balanceData;
};

const getBalanceDataFromSnapshots = (
  accounts: AccountDictionary,
  accountSnapshots: AccountSnapshotDictionary,
  viewDate: ViewDate,
): BalanceData => {
  const balanceData = new BalanceData();
  const snapshotHistory: { [account_id: string]: AccountSnapshot }[] = [];

  const today = new Date();
  const todaySpan = viewDate.getSpanFrom(today);
  accounts.forEach((a) => balanceData.set(a.id, todaySpan, getAccountBalance(a)));

  // first aggregate snapshots to take the latest snapshot for each period
  accountSnapshots.forEach((accountSnapshot) => {
    const { snapshot, account } = accountSnapshot;
    const { date } = snapshot;
    if (!account.balances.current && account.balances.current !== 0) return;
    const snapshotDate = new Date(date);
    if (today < snapshotDate) return;
    const span = viewDate.getSpanFrom(snapshotDate);
    const existing = snapshotHistory[span];
    if (existing) {
      if (!existing[account.id] || existing[account.id].snapshot.date < date) {
        existing[account.id] = accountSnapshot;
      }
    } else {
      snapshotHistory[span] = { [account.id]: accountSnapshot };
    }
  });

  // then get the balance amount for each period
  for (let i = todaySpan + 1; i < snapshotHistory.length; i++) {
    for (const [accountId] of accounts) {
      const snapshot = snapshotHistory[i]?.[accountId];
      if (snapshot) {
        const snapshotBalance = getAccountBalance(snapshot.account);
        balanceData.set(accountId, i, snapshotBalance);
      }
    }
  }

  return balanceData;
};

export const getBalanceData = (data: Data, viewDate: ViewDate) => {
  const { accounts, accountSnapshots, transactions, investmentTransactions } = data;

  const transactionBasedData = getBalanceDataFromTransactions(
    accounts,
    transactions,
    investmentTransactions,
    viewDate,
  );

  const snapshotBasedData = getBalanceDataFromSnapshots(accounts, accountSnapshots, viewDate);

  const mergedData = new BalanceData();

  accounts.forEach(({ id, graphOptions }) => {
    const maxLength = Math.max(
      transactionBasedData.get(id).length,
      snapshotBasedData.get(id).length,
    );
    for (let i = maxLength - 1; i >= 0; i--) {
      const { useTransactions = true, useSnapshots = true } = graphOptions;
      const transactionBasedBalance = transactionBasedData.get(id, i);
      const snapshotBasedBalance = snapshotBasedData.get(id, i);
      let balance = 0;
      if (useSnapshots && snapshotBasedBalance) balance = snapshotBasedBalance;
      else if (useTransactions && transactionBasedBalance) balance = transactionBasedBalance;
      else balance = mergedData.get(id, i + 1)!;
      mergedData.set(id, i, balance);
    }
  });

  return mergedData;
};

export const useBalanceCalculator = () => {
  const { setData, viewDate } = useAppContext();

  const callback = async () => {
    setData((oldData) => {
      const newData = new Data(oldData);

      const accounts = new AccountDictionary(newData.accounts);
      const balanceData = getBalanceData(newData, new ViewDate(viewDate.getInterval()));
      accounts.forEach((account) => {
        const newAccount = new Account(account);
        newAccount.balanceHistory = balanceData.get(account.id);
        accounts.set(account.id, newAccount);
      });

      newData.update({ accounts });

      return newData;
    });
  };

  return useCallback(callback, [viewDate, setData]);
};

interface UseAccountGraphOptions {
  startDate?: Date;
  viewDate?: ViewDate;
  useLengthFixer?: boolean;
}

export const useAccountGraph = (accounts: Account[], options: UseAccountGraphOptions = {}) => {
  const { viewDate } = useAppContext();
  const { viewDate: inputViewDate, startDate, useLengthFixer = true } = options;

  const graphViewDate = useMemo(() => {
    if (inputViewDate) return inputViewDate;
    return new ViewDate(viewDate.getInterval());
  }, [viewDate, inputViewDate]);

  const { graphData, cursorAmount } = useMemo(() => {
    const flattened: number[] = [];
    accounts.forEach(({ balanceHistory }) => {
      const maxLength = startDate
        ? graphViewDate.getSpanFrom(startDate) + 1
        : balanceHistory?.length || 0;

      for (let i = 0; i < maxLength; i++) {
        if (flattened[i] === undefined) flattened[i] = 0;
        flattened[i] += balanceHistory?.[i] || 0;
      }
    });

    const { length } = flattened;

    const lengthFixer = useLengthFixer ? 3 - ((length - 1) % 3) : 0;
    flattened.push(...new Array(lengthFixer));

    const sequence = flattened.reverse();

    const viewDateIndex = graphViewDate.getSpanFrom(viewDate.getEndDate()) - lengthFixer;
    const cursorIndex = length - 1 - viewDateIndex;
    const cursorAmount = sequence[cursorIndex] as number | undefined;
    const points = [];
    if (cursorAmount === undefined) {
      const arbitraryAmount = sequence[cursorIndex - 1] || sequence[cursorIndex + 1] || 0;
      points.push({ point: { value: arbitraryAmount, index: cursorIndex }, color: "#0970" });
    } else {
      points.push({ point: { value: cursorAmount, index: cursorIndex }, color: "#097" });
    }

    const graphData: GraphInput = { lines: [{ sequence, color: "#097" }], points };

    return { graphData, cursorAmount };
  }, [accounts, startDate, useLengthFixer, graphViewDate, viewDate]);

  return { graphViewDate, graphData, cursorAmount };
};
