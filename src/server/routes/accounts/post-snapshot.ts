import { JSONAccount, getSquashedDateString, JSONSnapshot } from "common";
import { Route, upsertSnapshots } from "server";

export interface SnapshotPostResponse {
  snapshot_id: string;
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

    if (!req.body || typeof req.body !== "object" || !("snapshot" in req.body)) {
      return {
        status: "failed",
        message: "Request body must be a snapshot data",
      };
    }

    // TODO: Snapshot can be holding or security snapshot as well
    const account: JSONAccount = req.body.account;
    const date = req.body.snapshot.date ? new Date(req.body.snapshot.date) : new Date();
    const snapshot: JSONSnapshot = {
      snapshot_id: `${account.account_id}-${getSquashedDateString(date)}`,
      date: date.toISOString(),
    };

    const { user_id } = user;
    const newSnapshot = { user: { user_id }, snapshot, account };

    try {
      const response = await upsertSnapshots([newSnapshot]);
      const snapshot_id = response[0].update?._id || "";
      return { status: "success", body: { snapshot_id } };
    } catch (error: any) {
      console.error(`Failed to update a snapshot: ${snapshot.snapshot_id}`);
      throw new Error(error);
    }
  },
);
