import { Route, deleteSplitTransactions, requireQueryString, validationError } from "server";

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

    const idResult = requireQueryString(req, "id");
    if (!idResult.success) return validationError(idResult.error!);

    await deleteSplitTransactions(user, [idResult.data!]);

    return { status: "success" };
  }
);
