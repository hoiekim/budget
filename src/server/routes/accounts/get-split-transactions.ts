import { Route, searchSplitTransactions, SearchSplitTransactionsOptions, optionalQueryString, validateFields, validationError } from "server";
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
    // The parsed `start-date`/`end-date` become TIMESTAMPTZ predicates below:
    // reject a malformed or non-calendar date here instead of
    // letting Postgres raise 22007/22008 inside Route.execute.
    const dateCheck = validateFields({ "start-date": startResult.data, "end-date": endResult.data }, [{ path: "start-date", type: "date" }, { path: "end-date", type: "date" }]);
    if (!dateCheck.success) return validationError(dateCheck.error!);

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
