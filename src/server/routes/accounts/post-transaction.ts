import { Route, updateTransactions } from "server";

export interface TransactionPostResponse {
  transaction_id: string;
}

export const postTrasactionRoute = new Route<TransactionPostResponse>(
  "POST",
  "/transaction",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        message: "Request user is not authenticated.",
      };
    }

    try {
      const response = await updateTransactions(user, [req.body]);
      const result = response[0];
      if (!result || result.status >= 400) {
        throw new Error("Database responded with an error.");
      }
      const transaction_id = result.update._id || "";
      return { status: "success", body: { transaction_id } };
    } catch (error: any) {
      console.error(`Failed to update a transaction: ${req.body.transaction_id}`);
      throw new Error(error);
    }
  },
);
