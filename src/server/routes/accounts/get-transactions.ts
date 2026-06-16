import { Route, searchTransactions, SearchTransactionsOptions, optionalQueryString, validationError } from "server";
import { JSONTransaction, JSONInvestmentTransaction } from "common";

export interface TransactionsGetResponse {
  transactions: JSONTransaction[];
  investmentTransactions: JSONInvestmentTransaction[];
}

export const getTransactionsRoute = new Route<TransactionsGetResponse>(
  "GET",
  "/transactions",
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

    const includeDeletedResult = optionalQueryString(req, "include-deleted");
    if (!includeDeletedResult.success) return validationError(includeDeletedResult.error!);

    const options: SearchTransactionsOptions = {};
    if (startResult.data) options.startDate = startResult.data;
    if (endResult.data) options.endDate = endResult.data;
    if (accountResult.data) options.account_id = accountResult.data;
    // Pass-through tombstone delivery — repo will return soft-deleted
    // rows (`is_deleted = TRUE`) alongside active ones so the FE can
    // evict them from local cache. Defaults to false; the historic
    // contract (active-only) is preserved when the param is absent.
    if (includeDeletedResult.data === "true") options.includeDeleted = true;

    const response = await searchTransactions(user, options);

    const { transactions, investment_transactions } = response;

    return {
      status: "success",
      body: {
        transactions,
        investmentTransactions: investment_transactions,
      },
    };
  },
);
