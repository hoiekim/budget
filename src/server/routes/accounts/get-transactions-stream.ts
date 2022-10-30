import { InvestmentTransaction } from "plaid";
import {
  getTransactions,
  getInvestmentTransactions,
  Route,
  searchTransactions,
  upsertTransactions,
  deleteTransactions,
  upsertInvestmentTransactions,
  searchItems,
  upsertItems,
  Item,
  Transaction,
  PartialTransaction,
  RemovedTransaction,
  ApiResponse,
  appendTimeString,
} from "server";

export type TransactionsStreamGetResponse = {
  items: Item[];
  added: Transaction[];
  removed: RemovedTransaction[];
  modified: PartialTransaction[];
  investment: InvestmentTransaction[];
};

export const getTransactionsStreamRoute = new Route<TransactionsStreamGetResponse>(
  "GET",
  "/transactions-stream",
  async (req, res, stream) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        info: "Request user is not authenticated.",
      };
    }

    let counter = 0;
    const getStatus = (): ApiResponse["status"] => {
      if (counter > 1) return "success";
      counter++;
      return "streaming";
    };

    const getTransactionsFromElasticsearch = searchTransactions(user)
      .then(({ transactions, investment_transactions }) => {
        const data: TransactionsStreamGetResponse = {
          items: [],
          added: transactions,
          removed: [],
          modified: [],
          investment: investment_transactions,
        };
        stream({ status: getStatus(), data });

        return null;
      })
      .catch((err) => {
        console.error(err);
        stream({ status: getStatus() && "error" });
      });

    const promisedItems = searchItems(user);

    const getTransactionsFromPlaid = promisedItems
      .then((r) => getTransactions(user, r))
      .then(async (data) => {
        await getTransactionsFromElasticsearch;

        const { items, added, removed, modified } = data;

        const fillDateStrings = (e: typeof added[0]) => {
          const result = { ...e };
          const { authorized_date, date } = e;
          if (authorized_date) result.authorized_date = appendTimeString(authorized_date);
          if (date) result.date = appendTimeString(date);
          return result;
        };

        const filledAdded = added.map(fillDateStrings).map((e) => {
          return { ...e, label: {} };
        });

        const filledModified = added.map(fillDateStrings);

        const filledData: TransactionsStreamGetResponse = {
          ...data,
          added: filledAdded,
          modified: filledModified,
          investment: [],
        };

        stream({ status: getStatus(), data: filledData });

        const updateJobs = [
          upsertTransactions(user, [...filledAdded, ...modified]),
          deleteTransactions(user, removed),
        ];

        const partialItems = items.map(({ item_id, cursor }) => ({ item_id, cursor }));
        Promise.all(updateJobs).then(() => upsertItems(user, partialItems));

        return null;
      })
      .catch((err) => {
        console.error(err);
        stream({ status: getStatus() && "error" });
      });

    const getInvestmentTransactionsFromPlaid = promisedItems
      .then((r) => getInvestmentTransactions(user, r))
      .then(async (data) => {
        await getTransactionsFromElasticsearch;

        const { items, investmentTransactions } = data;

        const fillDateStrings = (e: typeof investmentTransactions[0]) => {
          const result = { ...e };
          const { date } = e;
          if (date) result.date = appendTimeString(date);
          return result;
        };

        const filledInvestments = investmentTransactions.map(fillDateStrings);

        const filledData: TransactionsStreamGetResponse = {
          items,
          added: [],
          removed: [],
          modified: [],
          investment: filledInvestments,
        };

        const updateJob = upsertInvestmentTransactions(user, filledInvestments);

        const partialItems = items.map(({ item_id, updated }) => ({ item_id, updated }));
        updateJob.then(() => upsertItems(user, partialItems));

        stream({ status: getStatus(), data: filledData });
      })
      .catch((err) => {
        console.error(err);
        stream({ status: getStatus() && "error" });
      });

    await Promise.all([
      getTransactionsFromElasticsearch,
      getTransactionsFromPlaid,
      getInvestmentTransactionsFromPlaid,
    ]);
  }
);
