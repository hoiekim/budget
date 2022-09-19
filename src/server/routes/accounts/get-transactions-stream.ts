import { InvestmentTransaction } from "plaid";
import {
  getTransactions,
  getInvestmentTransactions,
  Route,
  searchTransactions,
  indexTransactions,
  updateTransactions,
  deleteTransactions,
  updateItems,
  Item,
  Transaction,
  PartialTransaction,
  RemovedTransaction,
} from "server";
import { ApiResponse, searchItems } from "server/lib";

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

    const getTransactionsFromElasticsearch = searchTransactions(user).then(
      (transactions) => {
        const data: TransactionsStreamGetResponse = {
          items: [],
          added: transactions,
          removed: [],
          modified: [],
          investment: [],
        };
        stream({ status: getStatus(), data });

        return null;
      }
    );

    const getTransactionsFromPlaid = searchItems(user)
      .then((r) => getTransactions(user, r))
      .then(async (data) => {
        await getTransactionsFromElasticsearch;

        const { items, added, removed, modified } = data;

        console.info(
          "Plaid responded with " +
            `${added.length} added, ` +
            `${modified.length} modified and ` +
            `${removed.length} removed transactions data.`
        );

        const filledAdded = added.map((e) => ({ ...e, label: {} }));
        const filledData: TransactionsStreamGetResponse = {
          ...data,
          added: filledAdded,
          investment: [],
        };
        stream({ status: getStatus(), data: filledData });

        const updateJobs = [
          indexTransactions(user, filledAdded),
          updateTransactions(user, modified),
          deleteTransactions(user, removed),
        ];

        Promise.all(updateJobs).then(() => updateItems(user, items));

        return null;
      })
      .catch(console.error);

    const getInvestmentTransactionsFromPlaid = searchItems(user)
      .then((r) => getInvestmentTransactions(user, r))
      .then(async (data) => {
        await getTransactionsFromElasticsearch;

        const { items, investmentTransactions } = data;
        const filledData: TransactionsStreamGetResponse = {
          items,
          added: [],
          removed: [],
          modified: [],
          investment: investmentTransactions,
        };

        stream({ status: getStatus(), data: filledData });
      });

    await Promise.all([
      getTransactionsFromElasticsearch,
      getTransactionsFromPlaid,
      getInvestmentTransactionsFromPlaid,
    ]);
  }
);
