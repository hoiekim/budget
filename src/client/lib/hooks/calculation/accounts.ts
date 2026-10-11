import { useMemo } from "react";
import { InvestmentTransactionType } from "plaid";
import { getYearMonthString, LocalDate, ViewDate } from "common";
import {
  Account,
  AccountDictionary,
  AccountSnapshot,
  AccountSnapshotDictionary,
  BalanceData,
  GraphInput,
  HoldingSnapshot,
  HoldingSnapshotDictionary,
  InvestmentTransaction,
  InvestmentTransactionDictionary,
  Transaction,
  TransactionDictionary,
  useAppContext,
} from "client";
import { CostBasisPosition, foldCostBasis } from "./holdings";

export const getAccountBalance = (account: Account) => {
  // Use `current` for all account types. For investment accounts, Plaid's
  // `available` represents the cash component which is already included in
  // `current` — adding both would double-count cash/buying power.
  return account.balances.current || 0;
};

/**
 * Resolve the balance to display for an account at a given view date. Falls
 * back to the live balance for future dates and while history is still
 * streaming in; falls back to 0 for past dates once the load is complete.
 */
export const getDisplayBalance = (
  balanceData: BalanceData,
  account: Account,
  date: Date,
  today: Date,
  isHistoryLoading: boolean,
): number => {
  const recorded = balanceData.get(account.id, date);
  if (recorded !== undefined) return recorded;
  return date > today || isHistoryLoading ? getAccountBalance(account) : 0;
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
  const translate = (t: Transaction) => {
    const { account_id, authorized_date, date, amount } = t;
    if (!accounts.has(account_id)) return;
    const transactionDate = new LocalDate(authorized_date || date);
    if (today < transactionDate) return;
    const previousMonthDate = new ViewDate("month", transactionDate).previous().getEndDate();
    balanceData.add(account_id, previousMonthDate, amount);
  };

  transactions.forEach(translate);

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

  addInvestmentCostBasis(balanceData, accounts, investmentTransactions, today);

  return balanceData;
};

/**
 * Layers each investment account's running cost basis onto `balanceData`.
 *
 * The walk above reconstructs a cash balance exactly, because cash does not
 * appreciate and every change to it is a transaction. An investment balance
 * is quantity times *today's* price while a transaction carries only the
 * price of its own day, so that walk cannot run on one: subtracting the
 * second from the first yields neither figure.
 *
 * These accumulate forward from zero instead, through the same average-cost
 * rule {@link foldCostBasis} applies to a holding's own basis. A month reads
 * what the transactions through it cost, never a price quoted later — which
 * understates a position that has since appreciated, and is the floor worth
 * showing for a month no snapshot covers. {@link getBalanceData} prefers
 * either snapshot tier wherever one does.
 *
 * Cash and securities are both tracked because an account holds both, and a
 * purchase moves money between them rather than into the account. Counting
 * only one side reports the same dollar twice on the way in, or loses it on
 * the way out: a liquidation that credits no cash reads as a zeroed account
 * for that month and every month after it.
 */
const addInvestmentCostBasis = (
  balanceData: BalanceData,
  accounts: AccountDictionary,
  investmentTransactions: InvestmentTransactionDictionary,
  today: Date,
) => {
  const byAccount = new Map<string, InvestmentTransaction[]>();

  investmentTransactions.forEach((t) => {
    if (!accounts.has(t.account_id)) return;
    if (today < new LocalDate(t.date)) return;
    const forAccount = byAccount.get(t.account_id) ?? [];
    forAccount.push(t);
    byAccount.set(t.account_id, forAccount);
  });

  for (const [accountId, accountTransactions] of byAccount) {
    accountTransactions.sort(
      (a, b) => new LocalDate(a.date).getTime() - new LocalDate(b.date).getTime(),
    );

    // Average cost is per security — netting one security's sale against
    // another's basis would charge the sale to shares it never touched.
    const positions = new Map<string, CostBasisPosition>();
    // Cash carries its value in `amount`, not in shares, so it accumulates
    // separately. Plaid signs `amount` positive when cash leaves the account.
    let cash = 0;
    const monthlyTotals = new Map<number, number>();

    for (const t of accountTransactions) {
      const { type, amount } = t;
      if (type === InvestmentTransactionType.Buy || type === InvestmentTransactionType.Sell) {
        const securityId = t.security_id ?? "";
        positions.set(securityId, foldCostBasis(positions.get(securityId) ?? EMPTY_POSITION, t));
        // Both legs, or the money is counted twice on the way in and lost on
        // the way out: a purchase spends cash the account already held, and a
        // sale returns it. This is also what makes a broker's sweep come out
        // right without having to recognise one — the sweep buy spends
        // exactly the cash its own deposit row brought in.
        //
        // Direction comes from the type, because the sign of `amount` does
        // not carry it: one provider signs a movement positive when the money
        // arrives, and a manually entered row stores `quantity * price` with
        // both entered positive, so its sale is indistinguishable from its
        // purchase by sign alone. A sale therefore returns the size of its
        // amount whatever the sign — proceeds are booked nowhere else.
        //
        // A purchase spends only what it positively cost: the fold above has
        // already taken a negative cost out of the basis, so spending it here
        // as well would remove it twice. That is the lesser of two wrong
        // answers rather than a right one — a row whose type, quantity, price
        // and amount disagree has to be reconciled where it is written.
        //
        // Floored because the cash a purchase spent may have arrived before
        // the fetched window, and an account that bought with money this
        // never saw does not thereby hold a negative balance.
        cash =
          type === InvestmentTransactionType.Buy
            ? Math.max(0, cash - Math.max(0, amount))
            : cash + Math.abs(amount);
      } else {
        // Everything else moves money without moving shares — a fee, a
        // dividend, a deposit, a withdrawal, an in-kind transfer carrying its
        // value in `amount`. Floored for the same reason the purchase leg is.
        cash = Math.max(0, cash - amount);
      }

      const invested = Array.from(positions.values()).reduce((sum, p) => sum + p.totalCost, 0);
      const monthEnd = new ViewDate("month", new LocalDate(t.date)).getEndDate();
      // Floored for the same reason one step down: an account rolled over
      // into another leaves the withdrawal here while the deposit lands
      // somewhere this never sees.
      monthlyTotals.set(monthEnd.getTime(), Math.max(0, invested + cash));
    }

    for (const [month, total] of monthlyTotals) {
      const date = new Date(month);
      // `today`'s own month keeps the reported balance: it is the live market
      // value, which beats a cost basis for the one month we can observe.
      if (getYearMonthString(date) === getYearMonthString(today)) continue;
      balanceData.set(accountId, date, total);
    }
  }
};

const EMPTY_POSITION: CostBasisPosition = { totalCost: 0, totalQuantity: 0 };

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
