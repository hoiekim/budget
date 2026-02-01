import { Route, searchTransactions, SearchTransactionsOptions } from "server";
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

    const startString = req.query["start-date"] as string;
    const endString = req.query["end-date"] as string;
    const account_id = req.query["account-id"] as string;
    const start = new Date(startString);
    const end = new Date(endString);

    const options: SearchTransactionsOptions = {};
    if (startString && endString) options.range = { start, end };
    if (account_id) options.query = { account_id };

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
