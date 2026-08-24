import { JSONAccount, getSquashedDateString, JSONSnapshot, LocalDate } from "common";
import {
  Route,
  upsertSnapshots,
  requireBodyObject,
  validationError,
  getAccount,
} from "server";
import { logger } from "server/lib/logger";

export interface SnapshotPostResponse {
  snapshot_id: string;
  /** The date actually persisted, as an ISO string. The id and the stored date
   *  are both derived from the server's local midnight, so a client that echoed
   *  its own `new LocalDate(input)` into the cache would disagree with the next
   *  sync whenever the browser and the server sit in different zones. */
  date: string;
}

export const postSnapshotRoute = new Route<SnapshotPostResponse>(
  "POST",
  "/snapshot",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        message: "Request user is not authenticated.",
      };
    }

    const bodyResult = requireBodyObject(req);
    if (!bodyResult.success) return validationError(bodyResult.error!);

    const body = bodyResult.data as Record<string, unknown>;
    const snapshotData = body.snapshot;
    if (!snapshotData || typeof snapshotData !== "object" || Array.isArray(snapshotData)) {
      return validationError("Request body must contain snapshot data");
    }

    // TODO: Snapshot can be holding or security snapshot as well
    const account = body.account as JSONAccount | undefined;
    if (!account || typeof account !== "object" || typeof account.account_id !== "string") {
      return validationError("Request body must contain an account with an account_id");
    }

    if (!(await getAccount(user, account.account_id))) {
      return { status: "failed", message: "Account not found or access denied." };
    }

    const rawDate = (snapshotData as Record<string, unknown>).date;
    if (rawDate !== undefined && typeof rawDate !== "string") {
      return validationError("snapshot.date must be a string");
    }
    const date = rawDate ? new LocalDate(rawDate) : new Date();
    if (Number.isNaN(date.getTime())) {
      return validationError("snapshot.date is not a valid date");
    }
    const snapshot: JSONSnapshot = {
      snapshot_id: `${account.account_id}-${getSquashedDateString(date)}`,
      date: date.toISOString(),
    };

    const { user_id } = user;
    const newSnapshot = { user: { user_id }, snapshot, account };

    try {
      const response = await upsertSnapshots([newSnapshot]);
      const snapshot_id = response[0].update?._id || "";
      return { status: "success", body: { snapshot_id, date: snapshot.date } };
    } catch (error: unknown) {
      logger.error("Failed to update snapshot", { snapshotId: snapshot.snapshot_id }, error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  },
);
