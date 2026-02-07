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
      const updateResponse = response[0].update;
      const updateStatus = updateResponse?.status;
      const error = updateResponse?.error;
      if (error || (updateStatus && updateStatus >= 400)) {
        console.error(error);
        throw new Error("Elasticsearch responded with an error.");
      }
      const investment_transaction_id = response[0].update?._id || "";
      return { status: "success", body: { investment_transaction_id } };
    } catch (error: any) {
      console.error(
        `Failed to update an investment transaction: ${req.body.investment_transaction_id}`,
      );
      throw new Error(error);
    }
  },
);
