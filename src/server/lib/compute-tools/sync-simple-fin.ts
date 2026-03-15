import { AccountType } from "plaid";
import {
  JSONAccount,
  getDateString,
  getDateTimeString,
  JSONHolding,
  JSONInvestmentTransaction,
  JSONItem,
  RemovedInvestmentTransaction,
  RemovedTransaction,
  JSONTransaction,
  LocalDate,
  DEFAULT_GRAPH_OPTIONS,
} from "common";
import { SimpleFinRawAccount } from "../simple-fin/translators";
import {
  deleteInvestmentTransactions,
  deleteSplitTransactionsByTransaction,
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
import { withTransaction } from "../postgres/client";
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
    startDate,
  );

  const processHoldingsPromise = upsertSecuritiesWithSnapshots(securities).then((idMap) => {
    const mappedHoldings = holdings
      .map((h) => {
        const security_id = idMap[h.security_id];
        if (!security_id) return undefined;
        const newHolding: JSONHolding = { ...h, security_id };
        return newHolding;
      })
      .filter((h): h is JSONHolding => !!h);
    return upsertAndDeleteHoldingsWithSnapshots(user, mappedHoldings, storedHoldings);
  });

  const investmentAccounts: JSONAccount[] = [];
  const otherAccounts: JSONAccount[] = [];
  const existingAccountsMap = new Map(storedAccounts.map((a) => [a.account_id, a]));
  accounts.forEach((a: SimpleFinRawAccount) => {
    const existingAccount = existingAccountsMap.get(a.account_id);
    const incomingAccount: JSONAccount = {
      ...a,
      hide: existingAccount?.hide ?? false,
      custom_name: existingAccount?.custom_name ?? "",
      label: existingAccount?.label ?? {},
      graphOptions: existingAccount?.graphOptions ?? DEFAULT_GRAPH_OPTIONS,
    };
    if (a.type === AccountType.Investment) investmentAccounts.push(incomingAccount);
    else otherAccounts.push(incomingAccount);
  });

  const removedTransactionIds = removedTransactions.map((t) => t.transaction_id);
  const removedInvestmentTransactionIds = removedInvestmentTransaction.map(
    (t) => t.investment_transaction_id,
  );

  // Phase 1: idempotent writes (accounts, holdings, institutions) — safe to run outside a
  // transaction because they can be retried on the next sync without data loss.
  await upsertAccountsWithSnapshots(user, investmentAccounts, storedAccounts);
  await upsertAccounts(user, otherAccounts);
  await processHoldingsPromise;
  await upsertInstitutions(institutions);

  // Phase 2: transactional writes — transactions + cursor update must be atomic.
  // If the process crashes mid-way, the DB rolls back the entire block and the item cursor
  // is not advanced, so the next sync re-processes the same window safely.
  await withTransaction(async (client) => {
    await upsertTransactions(user, transactions, client);
    await deleteTransactions(user, removedTransactionIds, client);
    for (const txId of removedTransactionIds) {
      await deleteSplitTransactionsByTransaction(user, txId, client);
    }
    await upsertInvestmentTransactions(user, investmentTransactions, client);
    await deleteInvestmentTransactions(user, removedInvestmentTransactionIds, client);

    const updated = getDateString();
    await upsertItems(user, [{ ...item, updated }], true, client);
  });

  return { accounts, transactions, investmentTransactions };
};

const getStartDate = (item: JSONItem) => {
  const { updated } = item;
  if (updated) {
    const updatedDate = new LocalDate(getDateTimeString(updated));
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

const getStoredData = async (user: MaskedUser, item: JSONItem, startDate: Date) => {
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

export const getRemovedTransactions = (
  transactions: JSONTransaction[],
  storedTransactions: JSONTransaction[],
  startDate: Date,
) => {
  const accountIds = new Set(transactions.map((e) => e.account_id));
  const transactionIds = new Set(transactions.map((e) => e.transaction_id));
  const removedTransactions: RemovedTransaction[] = [];
  storedTransactions.forEach((t) => {
    const { transaction_id, date } = t;
    if (new LocalDate(date) < startDate) return;
    if (!accountIds.has(t.account_id)) return;
    if (!transactionIds.has(transaction_id)) removedTransactions.push({ transaction_id });
  });
  return removedTransactions;
};

export const getRemovedInvestmentTransactions = (
  investmentTransactions: JSONInvestmentTransaction[],
  storedInvestmentTransactions: JSONInvestmentTransaction[],
  startDate: Date,
) => {
  const accountIds = new Set(investmentTransactions.map((e) => e.account_id));
  const investmentTransactionIds = new Set(
    investmentTransactions.map((e) => e.investment_transaction_id),
  );
  const removedInvestmentTransactions: RemovedInvestmentTransaction[] = [];
  storedInvestmentTransactions.forEach((t) => {
    const { investment_transaction_id, date } = t;
    if (new LocalDate(date) < startDate) return;
    if (!accountIds.has(t.account_id)) return;
    if (!investmentTransactionIds.has(investment_transaction_id)) {
      removedInvestmentTransactions.push({ investment_transaction_id });
    }
  });
  return removedInvestmentTransactions;
};
