import { Route, searchSplitTransactions, SearchSplitTransactionsOptions } from "server";
import { SplitTransaction } from "common";

export type SplitTransactionsGetResponse = SplitTransaction[];

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

    const startString = req.query["start-date"] as string;
    const endString = req.query["end-date"] as string;
    const account_id = req.query["account-id"] as string;
    const start = new Date(startString);
    const end = new Date(endString);

    const options: SearchSplitTransactionsOptions = {};
    if (startString && endString) options.range = { start, end };
    if (account_id) options.query = { account_id };

    console.log(options);

    const response = await searchSplitTransactions(user, options);

    return { status: "success", body: response.split_transactions };
  }
);
