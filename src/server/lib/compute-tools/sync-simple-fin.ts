import { AccountType } from "plaid";
import {
  Account,
  getDateString,
  getDateTimeString,
  Holding,
  InvestmentTransaction,
  Item,
  RemovedInvestmentTransaction,
  RemovedTransaction,
  Transaction,
} from "common";
import {
  deleteInvestmentTransactions,
  deleteTransactions,
  getUserItem,
  MaskedUser,
  searchAccountsByItemId,
  searchHoldingsByAccountId,
  searchTransactionsByAccountId,
  simpleFin,
  upsertAccounts,
  upsertInstitutions,
  upsertInvestmentTransactions,
  upsertItems,
  upsertTransactions,
} from "server";
import {
  upsertSecuritiesWithSnapshots,
  upsertAccountsWithSnapshots,
  upsertAndDeleteHoldingsWithSnapshots,
} from "./create-snapshots";

export const syncSimpleFinData = async (item_id: string) => {
  const userItem = await getUserItem(item_id);
  if (!userItem) return;

  const { user, item } = userItem;

  const startDate = getStartDate(item);

  const [simpleFinData, storedData] = await Promise.all([
    simpleFin.getData(item, { startDate }),
    getStoredData(user, item, startDate),
  ]);

  const { accounts, institutions, holdings, securities, transactions, investmentTransactions } =
    simpleFinData;
  const {
    transactions: storedTransations,
    investment_transactions: storedInvestmentTransactions,
    accounts: storedAccounts,
    holdings: storedHoldings,
  } = storedData;

  const removedTransactions = getRemovedTransactions(transactions, storedTransations, startDate);

  const removedInvestmentTransaction = getRemovedInvestmentTransactions(
    investmentTransactions,
    storedInvestmentTransactions,
    startDate
  );

  const processHoldingsPromise = upsertSecuritiesWithSnapshots(securities).then((idMap) => {
    const mappedHoldings = holdings
      .map((h) => {
        const security_id = idMap[h.security_id];
        if (!security_id) return undefined;
        return new Holding({ ...h, security_id });
      })
      .filter((h): h is Holding => !!h);
    return upsertAndDeleteHoldingsWithSnapshots(user, mappedHoldings, storedHoldings);
  });

  const investmentAccounts: Account[] = [];
  const otherAccounts: Account[] = [];
  accounts.forEach((a) => {
    if (a.type === AccountType.Investment) investmentAccounts.push(a);
    else otherAccounts.push(a);
  });

  await upsertAccountsWithSnapshots(user, investmentAccounts, storedAccounts);
  await upsertAccounts(user, otherAccounts);
  await processHoldingsPromise;
  await upsertInstitutions(institutions);
  await upsertTransactions(user, transactions);
  await deleteTransactions(user, removedTransactions);
  await upsertInvestmentTransactions(user, investmentTransactions);
  await deleteInvestmentTransactions(user, removedInvestmentTransaction);

  const updated = getDateString();
  await upsertItems(user, [new Item({ ...item, updated })]);

  return { accounts, transactions, investmentTransactions };
};

const getStartDate = (item: Item) => {
  const { updated } = item;
  if (updated) {
    const updatedDate = new Date(getDateTimeString(updated));
    const date = updatedDate.getDate();
    updatedDate.setDate(date - 14);
    return updatedDate;
  } else {
    const oldestDate = new Date();
    const thisYear = new Date().getFullYear();
    oldestDate.setFullYear(thisYear - 2);
    return oldestDate;
  }
};

const getStoredData = async (user: MaskedUser, item: Item, startDate: Date) => {
  const { item_id } = item;
  const accounts = await searchAccountsByItemId(user, item_id);
  const accountIds = accounts?.map((e) => e.account_id) || [];

  const range = { start: startDate, end: new Date() };

  const [holdings, transactionsData] = await Promise.all([
    searchHoldingsByAccountId(user, accountIds),
    searchTransactionsByAccountId(user, accountIds, range),
  ]);

  const { transactions, investment_transactions } = transactionsData;
  return { accounts, holdings, transactions, investment_transactions };
};

const getRemovedTransactions = (
  transactions: Transaction[],
  storedTransactions: Transaction[],
  startDate: Date
) => {
  const removedTransactions: RemovedTransaction[] = [];
  storedTransactions.forEach((t) => {
    const { transaction_id, date } = t;
    if (new Date(date) < startDate) return;
    const found = transactions.find((f) => f.transaction_id === transaction_id);
    if (!found) removedTransactions.push({ transaction_id });
  });
  return removedTransactions;
};

const getRemovedInvestmentTransactions = (
  investmentTransactions: InvestmentTransaction[],
  storedInvestmentTransactions: InvestmentTransaction[],
  startDate: Date
) => {
  const removedInvestmentTransactions: RemovedInvestmentTransaction[] = [];
  storedInvestmentTransactions.forEach((t) => {
    const { investment_transaction_id, date } = t;
    if (new Date(date) < startDate) return;
    const found = investmentTransactions.find(
      (f) => f.investment_transaction_id === investment_transaction_id
    );
    if (!found) removedInvestmentTransactions.push({ investment_transaction_id });
  });
  return removedInvestmentTransactions;
};
