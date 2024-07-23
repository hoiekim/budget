import { Route, deleteSplitTransactions } from "server";

export const deleteSplitTransactionRoute = new Route(
  "DELETE",
  "/split-transaction",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        message: "Request user is not authenticated.",
      };
    }

    const split_transaction_id = req.query.id as string;
    await deleteSplitTransactions(user, [{ split_transaction_id }]);

    return { status: "success" };
  }
);
