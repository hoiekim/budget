import { Route, requireQueryString, getHoldingSnapshots } from "server";
import { HoldingSnapshot } from "server/lib/postgres/repositories/snapshots";

export interface GetHoldingSnapshotsResponse {
  snapshots: HoldingSnapshot[];
}

export const getHoldingSnapshotsRoute = new Route<GetHoldingSnapshotsResponse>(
  "GET",
  "/snapshots/holding",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return { status: "failed", message: "Request user is not authenticated." };
    }

    const options: Parameters<typeof getHoldingSnapshots>[1] = {};
    const accountIdResult = requireQueryString(req, "account_id");
    if (accountIdResult.success) options.account_id = accountIdResult.data!;

    const snapshots = await getHoldingSnapshots(user, options);
    return { status: "success", body: { snapshots } };
  },
);
