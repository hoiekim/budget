import { useMemo } from "react";
import { AccountSubtype, AccountType } from "plaid";
import { getYearMonthString, ViewDate } from "common";
import {
  Account,
  AccountSnapshot,
  InvestmentTransaction,
  Transaction,
  GraphInput,
  useAppContext,
  AccountDictionary,
  AccountSnapshotDictionary,
  InvestmentTransactionDictionary,
  TransactionDictionary,
  BalanceData,
} from "client";

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

const getBalanceDataFromTransactions = (
  accounts: AccountDictionary,
  transactions: TransactionDictionary,
  investmentTransactions: InvestmentTransactionDictionary,
): BalanceData => {
  const balanceData = new BalanceData();

  const today = new Date();
  accounts.forEach((a) => balanceData.set(a.id, today, getAccountBalance(a)));

  // first aggregates transactions to sum amounts for each period
  const translate = (t: Transaction | InvestmentTransaction) => {
    const authorized_date = "authorized_date" in t ? t.authorized_date : undefined;
    const { account_id, date, amount } = t;
    if (!accounts.has(account_id)) return;
    const transactionDate = new Date(authorized_date || date);
    if (today < transactionDate) return;
    const previousMonthDate = new ViewDate("month", transactionDate).previous().getEndDate();
    if ("price" in t && "quantity" in t) {
      const { price, quantity } = t as InvestmentTransaction;
      balanceData.add(account_id, previousMonthDate, -(price * quantity));
    } else {
      balanceData.add(account_id, previousMonthDate, amount);
    }
  };

  transactions.forEach(translate);
  investmentTransactions.forEach(translate);

  // then incrementally adds them up
  for (const [accountId] of accounts) {
    const history = balanceData.get(accountId);
    const { startDate, endDate } = history;
    if (!startDate || !endDate) continue;
    while (startDate.getEndDate() <= endDate.getEndDate()) {
      const amount = history.get(endDate.getEndDate()) || 0;
      const laterAmount = history.get(endDate.clone().next().getEndDate()) || 0;
      history.set(endDate.getEndDate(), laterAmount + amount);
      endDate.previous();
    }
  }

  return balanceData;
};

const getBalanceDataFromSnapshots = (
  accounts: AccountDictionary,
  accountSnapshots: AccountSnapshotDictionary,
): BalanceData => {
  const snapshotHistory: { [yearMonth: string]: { [account_id: string]: AccountSnapshot } } = {};

  const today = new Date();

  // first aggregates snapshots to take the latest snapshot for each period
  accountSnapshots.forEach((accountSnapshot) => {
    const { snapshot, account } = accountSnapshot;
    const { date } = snapshot;
    if (!account.balances.current && account.balances.current !== 0) return;
    const snapshotDate = new Date(date);
    if (today < snapshotDate) return;
    const key = getYearMonthString(snapshotDate);
    const existing = snapshotHistory[key];
    if (existing) {
      if (!existing[account.id] || existing[account.id].snapshot.date < date) {
        existing[account.id] = accountSnapshot;
      }
    } else {
      snapshotHistory[key] = { [account.id]: accountSnapshot };
    }
  });

  // then transforms it into balance data
  const balanceData = new BalanceData();
  Object.values(snapshotHistory).forEach((accountSnapshots) => {
    for (const [accountId] of accounts) {
      const accountSnapshot = accountSnapshots[accountId];
      if (accountSnapshot) {
        const snapshotDate = new Date(accountSnapshot.snapshot.date);
        const snapshotBalance = getAccountBalance(accountSnapshot.account);
        balanceData.set(accountId, snapshotDate, snapshotBalance);
      }
    }
  });

  // makes sure today's balance takes priority over snapshots.
  accounts.forEach((a) => balanceData.set(a.id, today, getAccountBalance(a)));

  return balanceData;
};

export const getBalanceData = (
  accounts: AccountDictionary,
  accountSnapshots: AccountSnapshotDictionary,
  transactions: TransactionDictionary,
  investmentTransactions: InvestmentTransactionDictionary,
) => {
  const transactionBasedData = getBalanceDataFromTransactions(
    accounts,
    transactions,
    investmentTransactions,
  );

  const snapshotBasedData = getBalanceDataFromSnapshots(accounts, accountSnapshots);

  const mergedData = new BalanceData();

  accounts.forEach(({ id, graphOptions }) => {
    const startDate1 = transactionBasedData.get(id).startDate!;
    const startDate2 = snapshotBasedData.get(id).startDate!;
    const startDate = startDate1.getEndDate() < startDate2.getEndDate() ? startDate1 : startDate2;

    const endDate1 = transactionBasedData.get(id).endDate!;
    const endDate2 = snapshotBasedData.get(id).endDate!;
    const endDate = endDate1.getEndDate() < endDate2.getEndDate() ? endDate2 : endDate1;

    const { useTransactions = true, useSnapshots = true } = graphOptions;

    let previouslyUsedBalance = 0;
    while (startDate.getEndDate() <= endDate.getEndDate()) {
      const date = startDate.getEndDate();
      const transactionBasedBalance = transactionBasedData.get(id, date);
      const snapshotBasedBalance = snapshotBasedData.get(id, date);
      let balance = 0;
      if (useSnapshots && snapshotBasedBalance) {
        balance = snapshotBasedBalance;
      } else if (useTransactions && transactionBasedBalance) {
        balance = transactionBasedBalance;
      } else {
        balance = previouslyUsedBalance;
      }
      mergedData.set(id, date, balance);
      previouslyUsedBalance = balance;
      startDate.next();
    }
  });

  return mergedData;
};

interface UseAccountGraphOptions {
  startDate?: Date;
  viewDate?: ViewDate;
  useLengthFixer?: boolean;
}

export const useAccountGraph = (accounts: Account[], options: UseAccountGraphOptions = {}) => {
  const { viewDate, calculations } = useAppContext();
  const { balanceData } = calculations;
  const { viewDate: inputViewDate, startDate, useLengthFixer = true } = options;

  const graphViewDate = useMemo(() => {
    if (inputViewDate) return inputViewDate;
    return new ViewDate(viewDate.getInterval());
  }, [viewDate, inputViewDate]);

  const { graphData, cursorAmount } = useMemo(() => {
    const flattened: number[] = [];
    accounts.forEach(({ id }) => {
      const balanceArray = balanceData.get(id).toArray(graphViewDate);
      const maxLength = startDate
        ? graphViewDate.getSpanFrom(startDate) + 1
        : balanceArray.length || 0;

      for (let i = 0; i < maxLength; i++) {
        if (flattened[i] === undefined) flattened[i] = 0;
        flattened[i] += balanceArray[i] || 0;
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
  }, [accounts, balanceData, startDate, useLengthFixer, graphViewDate, viewDate]);

  return { graphViewDate, graphData, cursorAmount };
};
