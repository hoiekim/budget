import {
  Route,
  deleteInvestmentTransactions,
  getInvestmentTransaction,
  requireQueryString,
  validationError,
} from "server";

/**
 * Soft-delete a single manual investment transaction. Wired to
 * `InvestmentTransactionProperties`' Delete button on `source='manual'`
 * rows. Same rationale as `deleteTransactionRoute` — a stray
 * `Add Investment Transaction` click leaves a zero-quantity /
 * zero-price row that would clutter the transactions list forever
 * without this.
 *
 * Gated to `source='manual'` server-side: Plaid rows are sync-owned;
 * a manual delete would come back on the next incremental sync.
 */
export const deleteInvestmentTransactionRoute = new Route(
  "DELETE",
  "/investment-transaction",
  async (req) => {
    const { user } = req.session;
    if (!user) return { status: "failed", message: "Request user is not authenticated." };

    const idResult = requireQueryString(req, "investment_transaction_id");
    if (!idResult.success) return validationError(idResult.error!);
    const investment_transaction_id = idResult.data!;

    const tx = await getInvestmentTransaction(user, investment_transaction_id);
    if (!tx) return { status: "failed", message: "Investment transaction not found." };
    if (tx.source !== "manual") {
      return {
        status: "failed",
        message: "Only manual investment transactions can be deleted from the detail page.",
      };
    }

    const { deleted } = await deleteInvestmentTransactions(user, [investment_transaction_id]);
    if (!deleted) return { status: "failed", message: "Failed to delete investment transaction." };
    return { status: "success", body: { investment_transaction_id } };
  },
);
