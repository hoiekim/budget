import { Route, searchSplitTransactions, SearchSplitTransactionsOptions } from "server";
import { JSONSplitTransaction } from "common";

export type SplitTransactionsGetResponse = JSONSplitTransaction[];

export const getSplitTransactionsRoute = new Route<SplitTransactionsGetResponse>(
  "GET",
  "/split-transactions",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        message: "Request user is not authenticated.",
      };
    }

    const account_id = req.query["account-id"] as string;

    const options: SearchSplitTransactionsOptions = {};
    if (account_id) options.account_id = account_id;

    const splitTransactions = await searchSplitTransactions(user, options);

    return { status: "success", body: splitTransactions };
  },
);
