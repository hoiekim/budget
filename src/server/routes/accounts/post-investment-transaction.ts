import { Route, upsertInvestmentTransactions } from "server";

export interface InvestmentTransactionPostResponse {
  investment_transaction_id: string;
}

export const postInvestmentTrasactionRoute = new Route<InvestmentTransactionPostResponse>(
  "POST",
  "/investment-transaction",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        message: "Request user is not authenticated.",
      };
    }

    try {
      const response = await upsertInvestmentTransactions(user, [req.body], false);
      const result = response[0];
      if (!result || result.status >= 400) {
        throw new Error("Database responded with an error.");
      }
      const investment_transaction_id = result.update._id || "";
      return { status: "success", body: { investment_transaction_id } };
    } catch (error: any) {
      console.error(
        `Failed to update an investment transaction: ${req.body.investment_transaction_id}`,
      );
      throw new Error(error);
    }
  },
);
