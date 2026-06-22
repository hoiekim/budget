import { Route, rejectTransferPair, requireQueryString, validationError } from "server";

// DELETE /transfers?id=<pair_id> — the user's "this isn't right" action
// on a suggested-or-confirmed pair. Routes through `rejectTransferPair`
// which sets `status='rejected'` (not `is_deleted=TRUE`): the engine
// remembers the rejection and won't re-suggest THIS pair, but the two
// transactions remain eligible for other counterparts. Soft-deletion
// is reserved for the system cascade (when a transaction itself is
// removed).
export const deleteTransferRoute = new Route("DELETE", "/transfers", async (req) => {
  const { user } = req.session;
  if (!user) {
    return { status: "failed", message: "Request user is not authenticated." };
  }

  const idResult = requireQueryString(req, "id");
  if (!idResult.success) return validationError(idResult.error!);

  await rejectTransferPair(user, idResult.data!);

  return { status: "success" };
});
