import { ItemProvider, QueueWaitTimeoutError } from "common";
import { Route, deleteItem, plaid, searchItems, requireQueryString, validationError } from "server";
import { logger } from "server/lib/logger";

export const deleteItemRoute = new Route("DELETE", "/item", async (req, res) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      message: "Request user is not authenticated.",
    };
  }

  const idResult = requireQueryString(req, "id");
  if (!idResult.success) return validationError(idResult.error!);

  const items = await searchItems(user);
  const item = items.find((e) => e.item_id === idResult.data);
  if (!item) {
    return {
      status: "failed",
      message: "Specified item is not owned by the request user",
    };
  }

  if (item.provider === ItemProvider.PLAID) {
    // Without Plaid credentials the remote revocation can't run — still
    // delete locally; there's nothing reachable to clean up.
    if (plaid.isPlaidConfigured) {
      try {
        await plaid.deleteItem(user, item, { maxWaitMs: plaid.PLAID_FOREGROUND_WAIT_MS });
      } catch (error) {
        if (!(error instanceof QueueWaitTimeoutError)) throw error;
        // The remote revocation never ran, so the local row stays for a retry.
        logger.warn("Plaid item removal shed by the shared gate", {
          userId: user.user_id,
          itemId: item.item_id,
        });
        res.status(503);
        return { status: "failed", message: plaid.PLAID_BUSY_MESSAGE };
      }
    }
  }

  await deleteItem(user, idResult.data!);

  return { status: "success" };
});
