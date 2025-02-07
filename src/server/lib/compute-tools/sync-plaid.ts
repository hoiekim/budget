import {
  Account,
  InvestmentTransaction,
  Item,
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

export const syncPlaidTransactions = async (item_id: string) => {
  const userItem = await getUserItem(item_id);
  if (!userItem) return;
  const { user, item } = userItem;

  const accounts = await searchAccountsByItemId(user, item_id);
  const accountIds = accounts?.map((e) => e.account_id) || [];
  const storedTransactionsPromise = searchTransactionsByAccountId(user, accountIds);

  let addedCount = 0;
  let modifiedCount = 0;
  let removedCount = 0;

  const syncTransactions = plaid.getTransactions(user, [item]).then(async (r) => {
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

  const syncInvestmentTransactions = plaid
    .getInvestmentTransactions(user, [item])
    .then(async (r) => {
      const { items, investmentTransactions } = r;

      const fillDateStrings = (e: (typeof investmentTransactions)[0]) => {
        const result = { ...e };
        const { date } = e;
        if (date) result.date = getDateTimeString(date);
        return result;
      };

      const filledInvestments = investmentTransactions.map(fillDateStrings);

      const addedMap = new Map(
        filledInvestments.map((e) => [e.investment_transaction_id, new InvestmentTransaction(e)])
      );

      const storedTransactionsResult = await storedTransactionsPromise;
      const storedInvestmentTransactions = storedTransactionsResult?.investment_transactions || [];

      const removed: RemovedInvestmentTransaction[] = [];
      const modified: InvestmentTransaction[] = [];

      storedInvestmentTransactions.forEach((e) => {
        const age = new Date().getTime() - new Date(e.date).getTime();
        if (age > TWO_WEEKS) return;

        const { investment_transaction_id } = e;

        const found = investmentTransactions.find((f) => {
          return investment_transaction_id === f.investment_transaction_id;
        });

        if (!found) removed.push({ investment_transaction_id });
        else {
          modified.push(e);
          addedMap.delete(e.investment_transaction_id);
        }
      });

      const updateJobs = [
        upsertInvestmentTransactions(user, [...Array.from(addedMap.values()), ...modified]),
        deleteInvestmentTransactions(user, removed),
      ];

      const partialItems = items.map(({ item_id, updated }) => ({ item_id, updated }));
      return Promise.all(updateJobs)
        .then(() => {
          addedCount += addedMap.size;
          modifiedCount += modified.length;
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

  const syncAccounts = plaid
    .getAccounts(user, [item])
    .then(async (r) => {
      const accounts = r.accounts.map<Account>((e) => {
        return new Account(e);
      });
      upsertAccounts(user, accounts);
      return accounts;
    })
    .catch(console.error);

  const syncHoldings = Promise.all([
    plaid.getHoldings(user, [item]),
    getStoredAccountsData(user, item),
  ])
    .then(async ([plaidData, storedData]) => {
      const { accounts, holdings, securities } = plaidData;
      const { accounts: storedAccounts, holdings: storedHoldings } = storedData;
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
