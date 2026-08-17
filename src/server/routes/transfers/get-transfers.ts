import { Route, getTransferPairs, TransferPair, optionalQueryString, validationError } from "server";

export type TransfersGetResponse = TransferPair[];

export const getTransfersRoute = new Route<TransfersGetResponse>("GET", "/transfers", async (req) => {
  const { user } = req.session;
  if (!user) {
    return { status: "failed", message: "Request user is not authenticated." };
  }

  // `include-deleted=true` opts into eviction-signal delivery: soft-deleted
  // AND rejected pairs come back as empty-`transactions` rows the FE removes
  // from its cache. A caller that still full-fetches (no `include-deleted`)
  // gets the active-only shape unchanged.
  const includeDeletedResult = optionalQueryString(req, "include-deleted");
  if (!includeDeletedResult.success) return validationError(includeDeletedResult.error!);

  // `updated-after=<ISO>` narrows the fetch to pairs whose `updated` is
  // strictly greater — the FE's delta-by-cursor sync passes it. Omitted →
  // full fetch, so old clients keep working.
  const updatedAfterResult = optionalQueryString(req, "updated-after");
  if (!updatedAfterResult.success) return validationError(updatedAfterResult.error!);

  const pairs = await getTransferPairs(user, {
    includeDeleted: includeDeletedResult.data === "true",
    updatedAfter: updatedAfterResult.data,
  });
  return { status: "success", body: pairs };
});
