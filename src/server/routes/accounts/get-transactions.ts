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

    const options: SearchTransactionsOptions = {};
    if (startResult.data) options.startDate = startResult.data;
    if (endResult.data) options.endDate = endResult.data;
    if (accountResult.data) options.account_id = accountResult.data;

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
