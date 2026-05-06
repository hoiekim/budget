import { JSONSecurity } from "common";
import { Route, requireQueryString, getHoldingSnapshots, searchSecuritiesById } from "server";
import { HoldingSnapshot } from "server/lib/postgres/repositories/snapshots";

export interface HoldingSnapshotWithSecurity extends HoldingSnapshot {
  ticker_symbol: string | null;
  security_name: string | null;
}

export interface GetHoldingSnapshotsResponse {
  snapshots: HoldingSnapshotWithSecurity[];
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

    // Batch-fetch security info to include ticker_symbol and name
    const uniqueSecurityIds = [...new Set(snapshots.map((s) => s.holding_security_id))];
    const securities = await searchSecuritiesById(uniqueSecurityIds);
    const securityMap = new Map<string, JSONSecurity>(
      securities.map((s) => [s.security_id, s]),
    );

    const snapshotsWithSecurity: HoldingSnapshotWithSecurity[] = snapshots.map((s) => {
      const sec = securityMap.get(s.holding_security_id);
      return {
        ...s,
        ticker_symbol: sec?.ticker_symbol ?? null,
        security_name: sec?.name ?? null,
      };
    });

    return { status: "success", body: { snapshots: snapshotsWithSecurity } };
  },
);
