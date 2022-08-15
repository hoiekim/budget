import { Route, updateTransactionLabels } from "server";

export interface TransactionLabelPostResponse {
  transaction_id: string;
}

export const postTrasactionLabelRoute = new Route<TransactionLabelPostResponse>(
  "POST",
  "/transaction-label",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        info: "Request user is not authenticated.",
      };
    }

    try {
      const response = await updateTransactionLabels(user, [req.body]);
      const transaction_id = response[0].update?._id || "";
      return { status: "success", data: { transaction_id } };
    } catch (error: any) {
      console.error(`Failed to update a transaction: ${req.body.transaction_id}`);
      throw new Error(error);
    }
  }
);
