import { Route, createSplitTransaction } from "server";

export type NewSplitTransactionGetResponse = { split_transaction_id: string };

export const getNewSplitTransactionRoute = new Route<NewSplitTransactionGetResponse>(
  "GET",
  "/new-split-transaction",
  async (req, res) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        message: "Request user is not authenticated.",
      };
    }

    const transaction_id = req.query.parent as string;
    if (!transaction_id) throw new Error("Parent id is required but not provided.");
    const response = await createSplitTransaction(user, transaction_id);

    return { status: "success", body: { split_transaction_id: response._id } };
  }
);
