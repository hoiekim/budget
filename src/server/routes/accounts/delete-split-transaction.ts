import { Route, deleteSplitTransactions, requireUuidQueryString, validationError } from "server";

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

    const idResult = requireUuidQueryString(req, "id");
    if (!idResult.success) return validationError(idResult.error!);

    await deleteSplitTransactions(user, [idResult.data!]);

    return { status: "success" };
  }
);
