import {
  getTransactions,
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
import { searchItems } from "server/lib";

export type TransactionsStreamGetResponse = {
  items: Item[];
  added: Transaction[];
  removed: RemovedTransaction[];
  modified: PartialTransaction[];
};

export const getTransactionsStreamRoute = new Route(
  "GET",
  "/transactions-stream",
  async (req, res) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        info: "Request user is not authenticated.",
      };
    }

    const earlyRequest = searchTransactions(user).then((transactions) => {
      const data: TransactionsStreamGetResponse = {
        items: [],
        added: transactions,
        removed: [],
        modified: [],
      };
      res.write(JSON.stringify({ status: "streaming", data }) + "\n");
      return null;
    });

    const lateRequest = searchItems(user)
      .then((r) => getTransactions(user, r))
      .then(async (data) => {
        await earlyRequest;

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
        };
        res.write(JSON.stringify({ status: "success", data: filledData }) + "\n");

        const updateJobs = [
          indexTransactions(user, filledAdded),
          updateTransactions(user, modified),
          deleteTransactions(user, removed),
        ];

        Promise.all(updateJobs).then(() => updateItems(user, items));

        return null;
      })
      .catch(console.error);

    await Promise.all([earlyRequest, lateRequest]);
  }
);
