import { Route, getTransferPairs, TransferPair, optionalQueryString, validateFields, validationError } from "server";

export type TransfersGetResponse = TransferPair[];

export const getTransfersRoute = new Route<TransfersGetResponse>("GET", "/transfers", async (req) => {
  const { user } = req.session;
  if (!user) {
    return { status: "failed", message: "Request user is not authenticated." };
  }

  // Eviction-signal delivery is opt-in rather than hardcoded the way
  // /transactions and /snapshots do it, so a caller that has no cache to
  // reconcile — anything reading this endpoint for the current pair list —
  // isn't handed rows it would only have to filter back out. `useSync` opts
  // in on a warm sync and after a failed purge, not on a healthy cold load.
  const includeDeletedResult = optionalQueryString(req, "include-deleted");
  if (!includeDeletedResult.success) return validationError(includeDeletedResult.error!);

  const startResult = optionalQueryString(req, "start-date");
  if (!startResult.success) return validationError(startResult.error!);
  // The parsed `start-date` becomes a TIMESTAMPTZ predicate below: reject a
  // malformed or non-calendar date here instead of letting
  // Postgres raise 22007/22008 inside Route.execute.
  const dateCheck = validateFields({ "start-date": startResult.data }, [{ path: "start-date", type: "date" }]);
  if (!dateCheck.success) return validationError(dateCheck.error!);

  const pairs = await getTransferPairs(user, {
    includeDeleted: includeDeletedResult.data === "true",
    startDate: startResult.data,
  });
  return { status: "success", body: pairs };
});
