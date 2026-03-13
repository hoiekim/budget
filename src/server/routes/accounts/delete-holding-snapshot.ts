import { Route, requireQueryString, validationError, searchSnapshots, deleteSnapshotById } from "server";
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

    // Verify ownership: fetch holding snapshots for this user and check the ID exists
    const snapshots = await searchSnapshots(user, { snapshot_type: "holding" });
    const owned = snapshots.find((s) => "snapshot_id" in s && s.snapshot_id === snapshot_id);
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
