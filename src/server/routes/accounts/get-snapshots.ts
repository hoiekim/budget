import { JSONSnapshotData } from "common";
import { Route, searchSnapshots, SearchSnapshotsOptions, optionalQueryString, validationError } from "server";

export type SnapshotsGetResponse = JSONSnapshotData[];

const SNAPSHOT_TYPES = ["account_balance", "holding", "security"] as const;
type SnapshotType = (typeof SNAPSHOT_TYPES)[number];

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

    const startResult = optionalQueryString(req, "start-date");
    if (!startResult.success) return validationError(startResult.error!);

    const endResult = optionalQueryString(req, "end-date");
    if (!endResult.success) return validationError(endResult.error!);

    const accountResult = optionalQueryString(req, "account-id");
    if (!accountResult.success) return validationError(accountResult.error!);

    const securityResult = optionalQueryString(req, "security-id");
    if (!securityResult.success) return validationError(securityResult.error!);

    const typeResult = optionalQueryString(req, "snapshot-type");
    if (!typeResult.success) return validationError(typeResult.error!);
    if (typeResult.data && !SNAPSHOT_TYPES.includes(typeResult.data as SnapshotType)) {
      return validationError(
        `snapshot-type must be one of: ${SNAPSHOT_TYPES.join(", ")}`,
      );
    }

    const options: SearchSnapshotsOptions = {};
    if (startResult.data) options.startDate = startResult.data;
    if (endResult.data) options.endDate = endResult.data;
    if (accountResult.data) options.account_id = accountResult.data;
    if (securityResult.data) options.security_id = securityResult.data;
    if (typeResult.data) options.snapshot_type = typeResult.data as SnapshotType;

    const snapshots = await searchSnapshots(user, options);

    return { status: "success", body: snapshots };
  },
);
