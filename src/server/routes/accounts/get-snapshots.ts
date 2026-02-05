import { JSONSnapshotData } from "common";
import { Route, searchSnapshots, SearchSnapshotsOptions } from "server";

export type SnapshotsGetResponse = JSONSnapshotData[];

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
    const account_id = req.query["account-id"] as string;
    const holding_id = req.query["holding-id"] as string;
    const security_id = req.query["security-id"] as string;

    const options: SearchSnapshotsOptions = {};
    if (startString) options.startDate = startString;
    if (endString) options.endDate = endString;
    if (account_id) options.account_id = account_id;
    if (security_id) options.security_id = security_id;
    // Note: holding_id filtering would need to be added to the SearchSnapshotsOptions if needed

    const snapshots = await searchSnapshots(user, options);

    return { status: "success", body: snapshots };
  },
);
