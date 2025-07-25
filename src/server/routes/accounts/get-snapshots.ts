import { SnapshotData } from "common";
import { Route, searchSnapshots, SearchSnapshotsOptions } from "server";

export type SnapshotsGetResponse = SnapshotData[];

export const getSnapshotsRoute = new Route<SnapshotsGetResponse>(
  "GET",
  "/snapshots",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        message: "Request user is not authenticated.",
      };
    }

    const startString = req.query["start-date"] as string;
    const endString = req.query["end-date"] as string;
    const start = new Date(startString);
    const end = new Date(endString);

    const account_id = req.query["account-id"] as string;
    const holding_id = req.query["holding-id"] as string;
    const security_id = req.query["security-id"] as string;

    const options: SearchSnapshotsOptions = {};
    if (startString && endString) options.range = { start, end };
    if (account_id) options.query = { account: { account_id } };
    if (holding_id) options.query = { holding: { holding_id } };
    if (security_id) options.query = { security: { security_id } };

    const snapshots = await searchSnapshots(user, options);

    return { status: "success", body: snapshots };
  }
);
