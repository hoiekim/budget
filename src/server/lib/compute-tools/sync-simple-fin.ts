import { randomUUID } from "crypto";
import {
  getDateString,
  getDateTimeString,
  Holding,
  InvestmentTransaction,
  Item,
  RemovedInvestmentTransaction,
  RemovedTransaction,
  Security,
  Transaction,
} from "common";
import {
  deleteHoldings,
  deleteInvestmentTransactions,
  deleteTransactions,
  getUserItem,
  RemovedHolding,
  searchAccountsByItemId,
  searchHoldingsByAccountId,
  searchSecurities,
  searchTransactionsByAccountId,
  simpleFin,
  upsertAccounts,
  upsertHoldings,
  upsertInstitutions,
  upsertInvestmentTransactions,
  upsertItems,
  upsertSecurities,
  upsertTransactions,
  User,
} from "server";

export const syncSimpleFinData = async (item_id: string) => {
  const userItem = await getUserItem(item_id);
  if (!userItem) return;

  const { user, item } = userItem;

  const startDate = getStartDate(item);

  const [simpleFinData, storedData] = await Promise.all([
    simpleFin.getSimpleFinData(item, { startDate }),
    getStoredData(user, item, startDate),
  ]);

  const { accounts, institutions, holdings, securities, transactions, investmentTransactions } =
    simpleFinData;
  const {
    transactions: storedTransations,
    investment_transactions: storedInvestmentTransactions,
    holdings: storedHoldings,
  } = storedData;

  const removedTransactions = getRemovedTransactions(transactions, storedTransations, startDate);

  const removedInvestmentTransaction = getRemovedInvestmentTransactions(
    investmentTransactions,
    storedInvestmentTransactions,
    startDate
  );

  const removedHoldings = getRemovedHoldings(holdings, storedHoldings);

  const processHoldingsPromise = processSecurities(securities).then((idMap) => {
    const mappedHoldings = holdings
      .map((h) => {
        const security_id = idMap[h.security_id];
        if (!security_id) return undefined;
        return new Holding({ ...h, security_id });
      })
      .filter((h): h is Holding => !!h);
    return upsertHoldings(user, mappedHoldings);
  });

  await Promise.all([
    upsertAccounts(user, accounts),
    processHoldingsPromise,
    deleteHoldings(user, removedHoldings),
    upsertInstitutions(institutions),
    upsertTransactions(user, transactions),
    deleteTransactions(user, removedTransactions),
    upsertInvestmentTransactions(user, investmentTransactions),
    deleteInvestmentTransactions(user, removedInvestmentTransaction),
  ]);

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

const getStoredData = async (user: User, item: Item, startDate: Date) => {
  const { item_id } = item;
  const accounts = await searchAccountsByItemId(user, item_id);
  const accountIds = accounts?.map((e) => e.account_id) || [];

  const range = { start: startDate, end: new Date() };

  const [holdings, transactionsData] = await Promise.all([
    searchHoldingsByAccountId(user, accountIds),
    searchTransactionsByAccountId(user, accountIds, range),
  ]);

  const { transactions, investment_transactions } = transactionsData;
  return { holdings, transactions, investment_transactions };
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

const getRemovedHoldings = (holdings: Holding[], storedHoldings: Holding[]) => {
  const removedHoldings: RemovedHolding[] = [];
  storedHoldings.forEach((h) => {
    const { holding_id } = h;
    const found = holdings.find((f) => f.holding_id === holding_id);
    if (!found) removedHoldings.push({ holding_id });
  });
  return removedHoldings;
};

const processSecurities = async (securities: Security[]) => {
  const newSecurities: Security[] = [];
  const idMap: { [key: string]: string } = {};

  const promises = securities.map(async (s) => {
    const { security_id, ticker_symbol, iso_currency_code, close_price, close_price_as_of } = s;
    const storedSecurity = await searchSecurities({ ticker_symbol, iso_currency_code });
    if (storedSecurity.length) {
      const existingSecurity = new Security(storedSecurity[0]);
      idMap[security_id] = existingSecurity.security_id;
      const { close_price: existingPrice, close_price_as_of: existingDate } = existingSecurity;
      if (close_price !== existingPrice || close_price_as_of !== existingDate) {
        existingSecurity.close_price = close_price;
        existingSecurity.close_price_as_of = close_price_as_of;
        newSecurities.push(existingSecurity);
      }
      return existingSecurity;
    } else {
      const newSecurity = new Security({ ...s, security_id: randomUUID() });
      newSecurities.push(newSecurity);
      idMap[security_id] = newSecurity.security_id;
      return newSecurity;
    }
  });

  await Promise.all(promises);
  await upsertSecurities(newSecurities);

  return idMap;
};
