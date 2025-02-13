import {
  Account,
  InvestmentTransaction,
  Item,
  ItemProvider,
  RemovedInvestmentTransaction,
  TWO_WEEKS,
  Transaction,
  getDateString,
  getDateTimeString,
} from "common";
import {
  deleteInvestmentTransactions,
  deleteTransactions,
  plaid,
  getUserItem,
  upsertAccounts,
  upsertInvestmentTransactions,
  upsertItems,
  upsertTransactions,
  searchAccountsByItemId,
  searchTransactionsByAccountId,
  searchHoldingsByAccountId,
  MaskedUser,
} from "server";
import {
  upsertAccountsWithSnapshots,
  upsertAndDeleteHoldingsWithSnapshots,
  upsertSecuritiesWithSnapshots,
} from "./create-snapshots";
import { Products } from "plaid";

export const syncPlaidTransactions = async (item_id: string) => {
  const userItem = await getUserItem(item_id);
  if (!userItem) return;
  const { user, item } = userItem;
  if (item.provider !== ItemProvider.PLAID) return;

  const accounts = await searchAccountsByItemId(user, item_id);
  const accountIds = accounts?.map((e) => e.account_id) || [];

  const startDate = getTwoYearsAgo();

  const range = { start: startDate, end: new Date() };
  const storedTransactionsPromise = searchTransactionsByAccountId(user, accountIds, range);

  let addedCount = 0;
  let modifiedCount = 0;
  let removedCount = 0;

  const syncTransactions =
    item.available_products.includes(Products.Transactions) &&
    plaid.getTransactions(user, [item]).then(async (r) => {
      const storedTransactionsResult = await storedTransactionsPromise;
      const storedTransactions = storedTransactionsResult?.transactions || [];

      const { items, added, removed, modified } = r;

      const modelize = (e: (typeof added)[0]) => {
        const result = new Transaction(e);
        const { authorized_date: auth_date, date } = e;
        if (auth_date) result.authorized_date = getDateTimeString(auth_date);
        if (date) result.date = getDateTimeString(date);
        const existing = storedTransactions.find((f) => {
          const idMatches = e.transaction_id === f.transaction_id;
          const accountMatches = e.account_id === f.account_id;
          const nameMatches = e.name === f.name;
          const amountMatches = e.amount === f.amount;
          return idMatches || (accountMatches && nameMatches && amountMatches);
        });
        if (existing) result.label = existing.label;
        return result;
      };

      const modeledAdded = added.map(modelize);
      const modeledModified = modified.map(modelize);
      const updateJobs = [
        upsertTransactions(user, [...modeledAdded, ...modeledModified]),
        deleteTransactions(user, removed),
      ];

      const updated = getDateString();

      const partialItems = items.map(({ item_id, cursor }) => ({ item_id, cursor, updated }));
      return Promise.all(updateJobs)
        .then(() => {
          addedCount += added.length;
          modifiedCount += modified.length;
          removedCount += removed.length;
        })
        .then(() => upsertItems(user, partialItems))
        .catch((err) => {
          console.error("Error occured during puting Plaid transanctions data into Elasticsearch");
          console.error(err);
        });
    });

  const syncInvestmentTransactions =
    item.available_products.includes(Products.Investments) &&
    plaid.getInvestmentTransactions(user, [item]).then(async (r) => {
      const { items, investmentTransactions } = r;

      const fillDateStrings = (e: (typeof investmentTransactions)[0]) => {
        const result = { ...e };
        const { date } = e;
        if (date) result.date = getDateTimeString(date);
        return result;
      };

      const filledInvestments = investmentTransactions.map(fillDateStrings);

      const storedTransactionsResult = await storedTransactionsPromise;
      const storedInvestmentTransactions = storedTransactionsResult?.investment_transactions || [];

      const removed: RemovedInvestmentTransaction[] = [];

      storedInvestmentTransactions.forEach((e) => {
        const age = new Date().getTime() - new Date(e.date).getTime();
        if (age > TWO_WEEKS) return;

        const { investment_transaction_id } = e;

        const found = investmentTransactions.find((f) => {
          return investment_transaction_id === f.investment_transaction_id;
        });

        if (!found) removed.push({ investment_transaction_id });
        else {
          modifiedCount += 1;
          addedCount -= 1;
        }
      });

      const updateJobs = [
        upsertInvestmentTransactions(user, filledInvestments),
        deleteInvestmentTransactions(user, removed),
      ];

      const partialItems = items.map(({ item_id, updated }) => ({ item_id, updated }));
      return Promise.all(updateJobs)
        .then(() => {
          addedCount += filledInvestments.length;
          removedCount += removed.length;
        })
        .then(() => upsertItems(user, partialItems))
        .catch((err) => {
          console.error(
            "Error occured during puting Plaid investment transanctions data into Elasticsearch"
          );
          console.error(err);
        });
    });

  await Promise.all([syncTransactions, syncInvestmentTransactions]);

  return {
    added: addedCount,
    modified: modifiedCount,
    removed: removedCount,
  };
};

export const syncPlaidAccounts = async (item_id: string) => {
  const userItem = await getUserItem(item_id);
  if (!userItem) return;
  const { user, item } = userItem;
  if (item.provider !== ItemProvider.PLAID) return;

  const { accounts: storedAccounts, holdings: storedHoldings } = await getStoredAccountsData(
    user,
    item
  );
  const storedAccountsMap = new Map(storedAccounts?.map((e) => [e.account_id, e]) || []);

  const syncAccounts = plaid
    .getAccounts(user, [item])
    .then(async (r) => {
      const accounts = r.accounts.map((a) => {
        const newAccount = new Account(a);
        const existing = storedAccountsMap.get(a.account_id);
        if (existing) {
          newAccount.hide = existing.hide;
          newAccount.custom_name = existing.custom_name;
          newAccount.label = existing.label;
        }
        return newAccount;
      });
      await upsertAccounts(user, accounts);
      return accounts;
    })
    .catch(console.error);

  const isInvestmentAvailable = item.available_products.includes(Products.Investments);
  const syncHoldings = Promise.resolve(isInvestmentAvailable)
    .then((r) => {
      if (!r) return;
      return plaid.getHoldings(user, [item]);
    })
    .then(async (r) => {
      if (!r) return;
      const { accounts, holdings, securities } = r;
      await upsertAccountsWithSnapshots(user, accounts, storedAccounts);
      await upsertAndDeleteHoldingsWithSnapshots(user, holdings, storedHoldings);
      await upsertSecuritiesWithSnapshots(securities);
      return accounts;
    })
    .catch(console.error);

  const [accounts, investmentAccounts] = await Promise.all([syncAccounts, syncHoldings]);
  return { accounts, investmentAccounts };
};

const getStoredAccountsData = async (user: MaskedUser, item: Item) => {
  const { item_id } = item;
  const accounts = await searchAccountsByItemId(user, item_id);
  const accountIds = accounts?.map((e) => e.account_id) || [];
  const holdings = await searchHoldingsByAccountId(user, accountIds);
  return { accounts, holdings };
};

const getTwoYearsAgo = () => {
  const oldestDate = new Date();
  const thisYear = new Date().getFullYear();
  oldestDate.setFullYear(thisYear - 2);
  return oldestDate;
};
