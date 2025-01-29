import {
  Account,
  InvestmentTransaction,
  ONE_HOUR,
  RemovedInvestmentTransaction,
  TWO_WEEKS,
  Transaction,
  getDateString,
  getDateTimeString,
} from "common";
import {
  deleteInvestmentTransactions,
  deleteTransactions,
  plaidClient,
  getUserItem,
  searchItems,
  searchTransactions,
  upsertAccounts,
  upsertHoldings,
  upsertInvestmentTransactions,
  upsertItems,
  upsertSecurities,
  upsertTransactions,
} from "server";

export const syncAllTransactions = async (item_id: string) => {
  const userItem = await getUserItem(item_id);
  if (!userItem) return;
  const { user, item } = userItem;

  const getTransactionsFromElasticsearch = searchTransactions(user);

  let addedCount = 0;
  let modifiedCount = 0;
  let removedCount = 0;

  const syncTransactions = plaidClient.getTransactions(user, [item]).then(async (r) => {
    const ingestedTrasactions = await getTransactionsFromElasticsearch;
    const ingestedData = ingestedTrasactions?.transactions || [];

    const { items, added, removed, modified } = r;

    const modelize = (e: (typeof added)[0]) => {
      const result = new Transaction(e);
      const { authorized_date: auth_date, date } = e;
      if (auth_date) result.authorized_date = getDateTimeString(auth_date);
      if (date) result.date = getDateTimeString(date);
      const existing = ingestedData.find((f) => {
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

  const syncInvestmentTransactions = plaidClient
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

      const ingestedTrasactions = await getTransactionsFromElasticsearch;
      const ingestedData = ingestedTrasactions?.investment_transactions || [];

      const removed: RemovedInvestmentTransaction[] = [];
      const modified: InvestmentTransaction[] = [];

      ingestedData.forEach((e) => {
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
      Promise.all(updateJobs)
        .then(() => {
          addedCount += addedMap.size;
          modifiedCount += modified.length;
          removedCount += removed.length;
        })
        .then(() => upsertItems(user, partialItems));
    });

  await Promise.all([syncTransactions, syncInvestmentTransactions]);

  return {
    added: addedCount,
    modified: modifiedCount,
    removed: removedCount,
  };
};

export const syncAllAccounts = async (item_id: string) => {
  const userItem = await getUserItem(item_id);
  if (!userItem) return;

  const { user, item } = userItem;

  const getAccountsFromPlaid = plaidClient
    .getAccounts(user, [item])
    .then(async (r) => {
      const accounts = r.accounts.map<Account>((e) => {
        return new Account(e);
      });
      upsertAccounts(user, accounts);
      return accounts;
    })
    .catch(console.error);

  const getHoldingsFromPlaid = plaidClient
    .getHoldings(user, [item])
    .then(async ({ accounts, holdings, securities }) => {
      upsertAccounts(user, accounts);
      upsertHoldings(user, holdings);
      upsertSecurities(user, securities);
      return accounts;
    })
    .catch(console.error);

  const [accounts, investmentAccounts] = await Promise.all([
    getAccountsFromPlaid,
    getHoldingsFromPlaid,
  ]);
  return { accounts, investmentAccounts };
};

export const scheduledSync = async () => {
  try {
    const items = await searchItems();
    const promises = items.flatMap(({ item_id }) => {
      const accountsPromise = syncAllAccounts(item_id)
        .then((r) => {
          if (!r) throw new Error("Error occured during syncAllAccounts");
          const { accounts, investmentAccounts } = r;
          const numberOfAccounts = accounts?.length || 0;
          const numberOfInvestmentAccounts = investmentAccounts?.length || 0;
          console.group(`Synced accounts for item: ${item_id}`);
          console.log(`${numberOfAccounts} accounts`);
          console.log(`${numberOfInvestmentAccounts} investmentAccounts`);
          console.groupEnd();
        })
        .catch(console.error);
      const transactionsPromise = syncAllTransactions(item_id)
        .then((r) => {
          if (!r) throw new Error("Error occured during syncAllTransactions");
          const { added, modified, removed } = r;
          console.group(`Synced transactions for item: ${item_id}`);
          console.log(`${added} added`);
          console.log(`${modified} modified`);
          console.log(`${removed} removed`);
          console.groupEnd();
        })
        .catch(console.error);
      return [accountsPromise, transactionsPromise];
    });
    await Promise.all(promises);
    console.log("Scheduled sync completed");
  } catch (err) {
    console.error("Error occured during scheduled sync");
    console.error(err);
  } finally {
    setTimeout(scheduledSync, ONE_HOUR);
  }
};
