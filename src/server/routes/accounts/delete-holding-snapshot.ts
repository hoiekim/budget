import { Route, requireQueryString, validationError, getHoldingSnapshots, deleteSnapshotById } from "server";
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

    // Verify ownership against the flat HoldingSnapshot shape — the previous
    // searchSnapshots call returned nested JSONHoldingSnapshot objects whose
    // snapshot_id lived under `.snapshot.snapshot_id`, so the lookup always
    // missed and every delete returned "not found".
    const snapshots = await getHoldingSnapshots(user);
    const owned = snapshots.some((s) => s.snapshot_id === snapshot_id);
    if (!owned) {
      return { status: "failed", message: "Snapshot not found or access denied." };
    }

    try {
      await deleteSnapshotById(user, snapshot_id);
      return { status: "success" };
    } catch (error: unknown) {
      logger.error("Failed to delete holding snapshot", { snapshot_id }, error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  },
);
