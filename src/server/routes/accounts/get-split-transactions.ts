import { Route, searchSplitTransactions, SearchSplitTransactionsOptions, optionalQueryString, validationError } from "server";
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

    const accountResult = optionalQueryString(req, "account-id");
    if (!accountResult.success) return validationError(accountResult.error!);

    const options: SearchSplitTransactionsOptions = {};
    if (accountResult.data) options.account_id = accountResult.data;

    const splitTransactions = await searchSplitTransactions(user, options);

    return { status: "success", body: splitTransactions };
  },
);
