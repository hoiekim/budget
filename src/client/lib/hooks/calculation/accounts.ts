import { useMemo } from "react";
import { AccountSubtype, AccountType } from "plaid";
import { getYearMonthString, LocalDate, ViewDate } from "common";
import { Account } from "../../models/Account";
import { AccountSnapshot, HoldingSnapshot } from "../../models/Snapshot";
import { InvestmentTransaction } from "../../models/InvestmentTransaction";
import { Transaction } from "../../models/Transaction";
import { useAppContext } from "../context";
import { GraphInput } from "../../../components/Graph/lib/graph";
import {
  AccountDictionary,
  AccountSnapshotDictionary,
  HoldingSnapshotDictionary,
  InvestmentTransactionDictionary,
  TransactionDictionary,
} from "../../models/Data";
import { BalanceData } from "../../models/Calcuations";

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
    const isInvestment = t instanceof InvestmentTransaction;
    const authorized_date = !isInvestment ? t.authorized_date : undefined;
    const { account_id, date, amount } = t;
    if (!accounts.has(account_id)) return;
    const transactionDate = new LocalDate(authorized_date || date);
    if (today < transactionDate) return;
    const previousMonthDate = new ViewDate("month", transactionDate).previous().getEndDate();
    if (isInvestment) {
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
    const snapshotDate = new LocalDate(date);
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
        const snapshotDate = new LocalDate(accountSnapshot.snapshot.date);
        const snapshotBalance = getAccountBalance(accountSnapshot.account);
        balanceData.set(accountId, snapshotDate, snapshotBalance);
      }
    }
  });

  // makes sure today's balance takes priority over snapshots.
  accounts.forEach((a) => balanceData.set(a.id, today, getAccountBalance(a)));

  return balanceData;
};

/**
 * Calculate balance data from holding snapshots.
 * For investment accounts, the balance is the sum of all holding values (quantity * price).
 * This provides historical balance data when account snapshots are not available.
 */
const getBalanceDataFromHoldingSnapshots = (
  accounts: AccountDictionary,
  holdingSnapshots: HoldingSnapshotDictionary,
): BalanceData => {
  // Group holding snapshots by yearMonth and account_id
  // Structure: { yearMonth: { account_id: { holding_id: HoldingSnapshot } } }
  const snapshotHistory: {
    [yearMonth: string]: { [account_id: string]: { [holding_id: string]: HoldingSnapshot } };
  } = {};

  const today = new Date();

  // Aggregate holding snapshots, keeping the latest snapshot per holding per period
  holdingSnapshots.forEach((holdingSnapshot) => {
    const { snapshot, holding } = holdingSnapshot;
    const { date } = snapshot;
    const { account_id, holding_id } = holding;

    // Skip if account doesn't exist in our accounts dictionary
    if (!accounts.has(account_id)) return;

    const snapshotDate = new LocalDate(date);
    if (today < snapshotDate) return;

    const key = getYearMonthString(snapshotDate);

    if (!snapshotHistory[key]) {
      snapshotHistory[key] = {};
    }
    if (!snapshotHistory[key][account_id]) {
      snapshotHistory[key][account_id] = {};
    }

    const existingHolding = snapshotHistory[key][account_id][holding_id];
    if (!existingHolding || existingHolding.snapshot.date < date) {
      snapshotHistory[key][account_id][holding_id] = holdingSnapshot;
    }
  });

  // Transform into balance data by summing holding values per account
  const balanceData = new BalanceData();

  Object.entries(snapshotHistory).forEach(([yearMonth, accountHoldings]) => {
    // Get a representative date for this month
    const monthDate = new LocalDate(`${yearMonth}-15`);

    for (const [accountId, holdings] of Object.entries(accountHoldings)) {
      // Sum up all holding values for this account in this period
      let totalValue = 0;
      for (const holdingSnapshot of Object.values(holdings)) {
        // Use institution_value which is quantity * price
        totalValue += holdingSnapshot.holding.institution_value || 0;
      }
      balanceData.set(accountId, monthDate, totalValue);
    }
  });

  return balanceData;
};

/**
 * Calculate balance data using 3-tier fallback:
 * 1. Account Snapshots (highest priority) - direct balance from Plaid snapshots
 * 2. Holding Snapshots (medium priority) - calculated from sum of holding values
 * 3. Transactions (lowest priority) - derived from transaction history
 */
export const getBalanceData = (
  accounts: AccountDictionary,
  accountSnapshots: AccountSnapshotDictionary,
  holdingSnapshots: HoldingSnapshotDictionary,
  transactions: TransactionDictionary,
  investmentTransactions: InvestmentTransactionDictionary,
) => {
  const transactionBasedData = getBalanceDataFromTransactions(
    accounts,
    transactions,
    investmentTransactions,
  );

  const accountSnapshotBasedData = getBalanceDataFromSnapshots(accounts, accountSnapshots);

  const holdingSnapshotBasedData = getBalanceDataFromHoldingSnapshots(accounts, holdingSnapshots);

  const mergedData = new BalanceData();

  accounts.forEach(({ id, graphOptions }) => {
    // Collect all available date ranges from all sources
    const ranges: ViewDate[] = [];
    const txHistory = transactionBasedData.get(id);
    const acctHistory = accountSnapshotBasedData.get(id);
    const holdHistory = holdingSnapshotBasedData.get(id);

    if (txHistory.startDate) ranges.push(txHistory.startDate);
    if (acctHistory.startDate) ranges.push(acctHistory.startDate);
    if (holdHistory.startDate) ranges.push(holdHistory.startDate);

    // If no data exists for this account, skip it
    if (ranges.length === 0) return;

    // Find earliest start date
    const startDate = ranges.reduce((earliest, current) =>
      current.getEndDate() < earliest.getEndDate() ? current : earliest,
    );

    // Find latest end date
    const endRanges: ViewDate[] = [];
    if (txHistory.endDate) endRanges.push(txHistory.endDate);
    if (acctHistory.endDate) endRanges.push(acctHistory.endDate);
    if (holdHistory.endDate) endRanges.push(holdHistory.endDate);

    const endDate = endRanges.reduce((latest, current) =>
      current.getEndDate() > latest.getEndDate() ? current : latest,
    );

    const { useTransactions = true, useSnapshots = true, useHoldingSnapshots = true } = graphOptions;

    let previouslyUsedBalance = 0;
    while (startDate.getEndDate() <= endDate.getEndDate()) {
      const date = startDate.getEndDate();
      const transactionBasedBalance = transactionBasedData.get(id, date);
      const accountSnapshotBasedBalance = accountSnapshotBasedData.get(id, date);
      const holdingSnapshotBasedBalance = holdingSnapshotBasedData.get(id, date);

      // 3-tier fallback: account snapshots → holding snapshots → transactions
      let balance = 0;
      if (useSnapshots && accountSnapshotBasedBalance !== undefined) {
        balance = accountSnapshotBasedBalance;
      } else if (useHoldingSnapshots && holdingSnapshotBasedBalance !== undefined) {
        balance = holdingSnapshotBasedBalance;
      } else if (useTransactions && transactionBasedBalance !== undefined) {
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
