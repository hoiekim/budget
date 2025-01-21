import {
  InvestmentTransaction,
  RemovedInvestmentTransaction,
  TWO_WEEKS,
  Transaction,
  getDateString,
  getDateTimeString,
} from "common";
import {
  deleteInvestmentTransactions,
  deleteTransactions,
  getInvestmentTransactions,
  getTransactions,
  getUserItem,
  searchTransactions,
  upsertInvestmentTransactions,
  upsertItems,
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

  const syncTransactions = getTransactions(user, [item]).then(async (r) => {
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

  const syncInvestmentTransactions = getInvestmentTransactions(user, [item]).then(async (r) => {
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
