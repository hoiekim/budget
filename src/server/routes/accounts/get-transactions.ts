import { Route, searchTransactions } from "server";
import { Transaction, InvestmentTransaction, SplitTransaction } from "common";

export interface TransactionsGetResponse {
  transactions: Transaction[];
  investmentTransactions: InvestmentTransaction[];
  splitTransactions: SplitTransaction[];
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
    const start = new Date(startString);
    const end = new Date(endString);

    const response = await searchTransactions(user, { range: { start, end } });
    const { transactions, investment_transactions, split_transactions } = response;

    return {
      status: "success",
      body: {
        transactions,
        investmentTransactions: investment_transactions,
        splitTransactions: split_transactions,
      },
    };
  }
);
