import { useMemo } from "react";
import {
  Account,
  AccountSnapshot,
  AccountSnapshotDictionary,
  InvestmentTransaction,
  InvestmentTransactionDictionary,
  isNumber,
  Transaction,
  TransactionDictionary,
  ViewDate,
} from "common";
import { GraphInput, useAppContext } from "client";

interface GraphOptions {
  startDate?: Date;
  viewDate?: ViewDate;
}

type UseAccountGraphOptionsType = GraphOptions & {
  useLengthFixer?: boolean;
};

class BalanceByAccount extends Map<string, number> {
  override get = (accountId: string) => {
    const existing = super.get(accountId);
    if (existing !== undefined) return existing;
    this.set(accountId, 0);
    return 0;
  };

  add = (accountId: string, amount: number) => {
    const existing = this.get(accountId);
    this.set(accountId, existing + amount);
  };
}

type BalanceHistory = BalanceByAccount[];

export const useAccountGraph = (accounts: Account[], options: UseAccountGraphOptionsType = {}) => {
  const { data, viewDate } = useAppContext();

  const graphViewDate = useMemo(() => {
    const { viewDate: inputViewDate } = options;
    if (inputViewDate) return inputViewDate;
    return new ViewDate(viewDate.getInterval());
  }, [viewDate, options]);

  const { transactions, investmentTransactions, accountSnapshots } = data;

  const { graphData, cursorAmount, previousAmount } = useMemo(() => {
    const { startDate, useLengthFixer = true } = options;

    const transactionBasedHistory = getBalanceHistoryFromTransactions(
      accounts,
      transactions,
      investmentTransactions,
      graphViewDate,
      startDate,
    );

    const snapshotBasedHistory = getBalanceHistoryFromSnapshots(
      accounts,
      accountSnapshots,
      graphViewDate,
      startDate,
    );
    const maxLength = Math.max(transactionBasedHistory.length, snapshotBasedHistory.length);

    const lastBalance = new BalanceByAccount();
    accounts.forEach(({ id }) => lastBalance.set(id, 0));

    const mergedHistory: number[] = [];
    for (let i = maxLength - 1; i >= 0; i--) {
      const transactionBased = transactionBasedHistory[i];
      const snapshotBased = snapshotBasedHistory[i];

      let totalBalance = 0;
      accounts.forEach(({ id, graphOptions }) => {
        const { useTransactions = true, useSnapshots = true } = graphOptions;
        let balance = 0;
        if (useSnapshots && snapshotBased?.has(id)) balance = snapshotBased.get(id);
        else if (useTransactions && transactionBased) balance = transactionBased.get(id);
        else balance = lastBalance.get(id);
        totalBalance += balance;
        lastBalance.set(id, balance);
      });

      mergedHistory[i] = totalBalance;
    }

    const { length } = mergedHistory;

    const lengthFixer = useLengthFixer ? 3 - ((length - 1) % 3) : 0;
    mergedHistory.push(...new Array(lengthFixer));

    const sequence = mergedHistory.reverse();

    const viewDateIndex = graphViewDate.getSpanFrom(viewDate.getEndDate()) - lengthFixer;
    const cursorIndex = length - 1 - viewDateIndex;
    const cursorAmount = sequence[cursorIndex] as number | undefined;
    const points = [];
    if (cursorAmount === undefined) {
      points.push({
        point: {
          value: sequence[cursorIndex - 1] || sequence[cursorIndex + 1] || 0,
          index: cursorIndex,
        },
        color: "#0970",
      });
    } else {
      points.push({ point: { value: cursorAmount, index: cursorIndex }, color: "#097" });
    }

    const previousViewDate = new ViewDate(viewDate.getInterval()).previous();
    const previousIndex = graphViewDate.getSpanFrom(previousViewDate.getEndDate()) - lengthFixer;
    const previousAmount = sequence[length - 1 - previousIndex] as number | undefined;

    const graphData: GraphInput = { lines: [{ sequence, color: "#097" }], points };

    return { graphData, cursorAmount, previousAmount };
  }, [
    accounts,
    transactions,
    investmentTransactions,
    accountSnapshots,
    options,
    graphViewDate,
    viewDate,
  ]);

  return { graphViewDate, graphData, cursorAmount, previousAmount };
};

const getBalanceHistoryFromTransactions = (
  accounts: Account[],
  transactions: TransactionDictionary,
  investmentTransactions: InvestmentTransactionDictionary,
  graphViewDate: ViewDate,
  startDate?: Date,
): BalanceHistory => {
  const accountIds = new Set<string>();
  const currentBalances = new BalanceByAccount();
  const balanceHistory: BalanceHistory = [];
  const today = new Date();
  const todaySpan = graphViewDate.getSpanFrom(today);
  balanceHistory[todaySpan] = currentBalances;
  accounts.forEach((a) => {
    accountIds.add(a.id);
    currentBalances.set(a.id, a.balances.current || 0);
  });
  if (startDate) balanceHistory[graphViewDate.getSpanFrom(startDate)] = new BalanceByAccount();

  // first aggregate transactions to sum amounts for each period
  const translate = (t: Transaction | InvestmentTransaction) => {
    const authorized_date = "authorized_date" in t ? t.authorized_date : undefined;
    const { date, amount } = t;
    if (!accountIds.has(t.account_id)) return;
    const transactionDate = new Date(authorized_date || date);
    if (today < transactionDate) return;
    const span = graphViewDate.getSpanFrom(transactionDate) + 1;
    if (startDate && balanceHistory.length <= span) return;
    if (!balanceHistory[span]) balanceHistory[span] = new BalanceByAccount();
    if ("price" in t && "quantity" in t) {
      const { price, quantity } = t as InvestmentTransaction;
      balanceHistory[span].add(t.account_id, -(price * quantity));
    } else {
      balanceHistory[span].add(t.account_id, amount);
    }
  };

  transactions.forEach(translate);
  investmentTransactions.forEach(translate);

  // then incrementally add them up
  for (let i = todaySpan + 1; i < balanceHistory.length; i++) {
    if (!balanceHistory[i]) balanceHistory[i] = new BalanceByAccount();
    for (const accountId of accountIds) {
      const previousBalance = balanceHistory[i - 1].get(accountId);
      balanceHistory[i].add(accountId, previousBalance);
    }
  }

  return balanceHistory;
};

const getBalanceHistoryFromSnapshots = (
  accounts: Account[],
  accountSnapshots: AccountSnapshotDictionary,
  graphViewDate: ViewDate,
  startDate?: Date,
): BalanceHistory => {
  const snapshotHistory: { [account_id: string]: AccountSnapshot }[] = [];
  const accountIds = new Set<string>();
  const currentBalances = new BalanceByAccount();
  const balanceHistory: BalanceHistory = [];
  const today = new Date();
  const todaySpan = graphViewDate.getSpanFrom(today);
  balanceHistory[todaySpan] = currentBalances;
  accounts.forEach((a) => {
    accountIds.add(a.id);
    currentBalances.set(a.id, a.balances.current || 0);
  });
  if (startDate) snapshotHistory[graphViewDate.getSpanFrom(startDate)] = {};

  // first aggregate snapshots to take the latest snapshot for each period
  accountSnapshots.forEach((accountSnapshot) => {
    const { snapshot, account } = accountSnapshot;
    const { date } = snapshot;
    if (!account.balances.current && account.balances.current !== 0) return;
    if (!accountIds.has(account.account_id)) return;
    const snapshotDate = new Date(date);
    if (startDate && snapshotDate < startDate) return;
    if (today < snapshotDate) return;
    const span = graphViewDate.getSpanFrom(snapshotDate);
    const existing = snapshotHistory[span];
    if (existing) {
      if (!existing[account.id] || existing[account.id]?.snapshot.date < date) {
        existing[account.id] = accountSnapshot;
      }
    } else {
      snapshotHistory[span] = { [account.id]: accountSnapshot };
    }
  });

  // then get the balance amount for each period
  for (let i = todaySpan + 1; i < snapshotHistory.length; i++) {
    for (const accountId of accountIds) {
      const snapshot = snapshotHistory[i]?.[accountId];
      const snapshotBalance = snapshot?.account.balances.current;
      if (isNumber(snapshotBalance)) {
        if (!balanceHistory[i]) balanceHistory[i] = new BalanceByAccount();
        balanceHistory[i].set(accountId, snapshotBalance);
      }
    }
  }

  return balanceHistory;
};
