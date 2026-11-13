import { Route, requireQueryString, validationError, getHoldingSnapshotById, deleteSnapshotById } from "server";
import { logger } from "server/lib/logger";

export const deleteHoldingSnapshotRoute = new Route(
  "DELETE",
  "/snapshots/holding",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return { status: "failed", message: "Request user is not authenticated." };
    }

    const idResult = requireQueryString(req, "id");
    if (!idResult.success) return validationError(idResult.error!);
    const snapshot_id = idResult.data!;

    // The by-id lookup is the ownership check: it is user-scoped, so a
    // miss is "not found or access denied" without fetching the whole list.
    const owned = (await getHoldingSnapshotById(user, snapshot_id)) !== undefined;
    if (!owned) {
      return { status: "failed", message: "Snapshot not found or access denied." };
    }

    try {
      // The delete's answer is the truth: the row can vanish between the
      // lookup and the delete, and only the soft-delete's row count knows.
      const deleted = await deleteSnapshotById(user, snapshot_id);
      if (!deleted) {
        return { status: "failed", message: "Snapshot not found or access denied." };
      }
      return { status: "success" };
    } catch (error: unknown) {
      logger.error("Failed to delete holding snapshot", { snapshot_id }, error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  },
);
