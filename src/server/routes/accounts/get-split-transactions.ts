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

    const startResult = optionalQueryString(req, "start-date");
    if (!startResult.success) return validationError(startResult.error!);

    const endResult = optionalQueryString(req, "end-date");
    if (!endResult.success) return validationError(endResult.error!);

    const accountResult = optionalQueryString(req, "account-id");
    if (!accountResult.success) return validationError(accountResult.error!);

    const options: SearchSplitTransactionsOptions = {
      // Always return soft-deleted rows so the FE can treat them as
      // tombstones and evict from local cache — matches the snapshots +
      // transactions route contract. Direct repo callers default to
      // active-only because they don't pass `includeDeleted`.
      includeDeleted: true,
    };
    if (startResult.data) options.startDate = startResult.data;
    if (endResult.data) options.endDate = endResult.data;
    if (accountResult.data) options.account_id = accountResult.data;

    const splitTransactions = await searchSplitTransactions(user, options);

    return { status: "success", body: splitTransactions };
  },
);
