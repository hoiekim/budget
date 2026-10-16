import { Route, dismissRecurring, requireQueryString, validationError } from "server";

// DELETE /recurrings?id=<recurring_id> — the user's "this isn't right"
// action on a suggested-or-confirmed recurring. Routes through
// `dismissRecurring` which sets `status='dismissed'` (not
// `is_deleted=TRUE`): the engine remembers the dismissal and won't
// re-suggest THIS merchant group, but the transactions stay eligible for
// other recurrings. Soft-deletion is reserved for the system cascade
// (when every member transaction is removed).
export const dismissRecurringRoute = new Route("DELETE", "/recurrings", async (req) => {
  const { user } = req.session;
  if (!user) {
    return { status: "failed", message: "Request user is not authenticated." };
  }

  const idResult = requireQueryString(req, "id");
  if (!idResult.success) return validationError(idResult.error!);

  await dismissRecurring(user, idResult.data!);

  return { status: "success" };
});
