import {
  Route,
  deleteTransactions,
  getTransaction,
  requireQueryString,
  validationError,
} from "server";

/**
 * Soft-delete a single manual transaction. Wired to
 * `TransactionProperties`' Delete button on `source='manual'` rows —
 * the primary reach for cleaning up an accidentally-minted shell (an
 * abandoned `Add Transaction` click leaves a permanent zero-amount
 * row without this).
 *
 * Gated to `source='manual'` server-side: Plaid-synced rows are owned
 * by the sync path and shouldn't be user-deletable from the detail
 * page (a manual delete would resurface on the next sync via upsert-
 * by-id anyway). Any future need to delete a Plaid row lives on a
 * separate admin flow.
 */
export const deleteTransactionRoute = new Route("DELETE", "/transaction", async (req) => {
  const { user } = req.session;
  if (!user) return { status: "failed", message: "Request user is not authenticated." };

  const idResult = requireQueryString(req, "id");
  if (!idResult.success) return validationError(idResult.error!);
  const transaction_id = idResult.data!;

  const tx = await getTransaction(user, transaction_id);
  if (!tx) return { status: "failed", message: "Transaction not found." };
  if (tx.source !== "manual") {
    return {
      status: "failed",
      message: "Only manual transactions can be deleted from the detail page.",
    };
  }

  const { deleted } = await deleteTransactions(user, [transaction_id]);
  if (!deleted) return { status: "failed", message: "Failed to delete transaction." };
  return { status: "success", body: { transaction_id } };
});
